/**
 * T-18 on the desktop app's own hub: login off (`SLAYZONE_SUPERVISED=1`,
 * `SLAYZONE_HUB_REQUIRE_LOGIN=0` — exactly what `sidecar-server-supervisor.ts` sets).
 * Nothing changes over REST, MCP or agent hooks: no principal, no owner check, every
 * id answers, every list holds every row, a hook from any computer is processed, and
 * nothing is audited.
 *
 * Its own file because the hub's registries are process-wide: one hub per process.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --experimental-loader ./packages/shared/test-utils/loader.ts \
 *   packages/apps/hub/src/owner-checks-http-login-off.test.ts
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import type { RestApiDeps } from '@slayzone/transport/server'
import { createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness.js'
import { relayAgentHook } from './agent-hook-relay-consumer.js'
import { bootInProcessHub, ownedBy, seedOwned, seedShared } from './owner-checks-harness.js'

let passed = 0
let failed = 0
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    failed++
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

const lines: { event: string }[] = []
setSecurityLogSink((l) => {
  try {
    lines.push(JSON.parse(l) as { event: string })
  } catch {
    // not ours
  }
})

async function main(): Promise<void> {
  console.log('\nT-18 owner checks: the desktop app’s hub (login off) is unchanged\n')
  const hub = await bootInProcessHub({ login: false })
  const A = ownedBy('A_SECRET', 'u-a', hub.root)
  const B = ownedBy('B_OWN', 'u-b', hub.root)
  seedOwned(hub.dbPath, A)
  seedOwned(hub.dbPath, B)
  seedShared(hub.dbPath, A, B)
  mkdirSync(join(hub.root, 'artifacts', A.task), { recursive: true })
  writeFileSync(join(hub.root, 'artifacts', A.task, `${A.artifact}.txt`), 'A_SECRET_FILE_BYTES')
  const raw = new Database(hub.dbPath)
  const db = createSlayzoneDbAdapter(raw)
  // The harness's second task shares the `<mark>_task` prefix (ambiguous to a prefix
  // lookup, rightly): not needed here.
  raw
    .prepare(`DELETE FROM terminal_tabs WHERE task_id LIKE '%\\_task\\_hibernated' ESCAPE '\\'`)
    .run()
  raw.prepare(`DELETE FROM tasks WHERE id LIKE '%\\_task\\_hibernated' ESCAPE '\\'`).run()
  const base = `http://127.0.0.1:${hub.port}`
  const json = async (path: string, init?: RequestInit) => {
    const r = await fetch(base + path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
    })
    return { status: r.status, text: await r.text() }
  }

  try {
    await test("anyone's ids answer over REST, with no session", async () => {
      for (const path of [
        `/api/tasks/${A.task}`,
        `/api/tasks/${A.task.slice(0, 6)}/progress`,
        `/api/artifacts/${A.artifact}`,
        `/api/tags?project=${A.project}`,
        `/api/session/${A.session}/task`
      ]) {
        const r = await json(path)
        assert(r.status === 200, `${path}: ${r.status} ${r.text}`)
      }
      const file = await json(`/api/artifacts/${A.artifact}/content`)
      assert(file.text === 'A_SECRET_FILE_BYTES', 'artifact file')
      // The cross-project blocker is listed as before.
      const bTask = await json(`/api/tasks/${B.task}`)
      assert(bTask.text.includes(A.task), 'blockers unfiltered')
    })

    await test('every REST list holds both owners’ rows', async () => {
      for (const path of [
        '/api/projects',
        '/api/tasks',
        '/api/tasks/search?q=task',
        '/api/artifacts/search?allTasks=1&q=_'
      ]) {
        const r = await json(path)
        assert(
          r.text.includes(A.mark) && r.text.includes(B.mark),
          `${path}: ${r.text.slice(0, 200)}`
        )
      }
      // The "Available:" hint on a miss is as before.
      const miss = await json('/api/tags?project=no-such-project')
      assert(miss.status === 404 && miss.text.includes('Available'), miss.text)
    })

    await test('MCP answers for any task, with no session', async () => {
      const post = async (sid: string | null, msg: unknown) =>
        fetch(`${base}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(sid ? { 'mcp-session-id': sid } : {})
          },
          body: JSON.stringify(msg)
        })
      const init = await post(null, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 't', version: '1' }
        }
      })
      const sid = init.headers.get('mcp-session-id')
      await init.text()
      assert(sid, 'mcp session')
      await (await post(sid, { jsonrpc: '2.0', method: 'notifications/initialized' })).text()
      const r = await post(sid, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_current_task_id', arguments: { task_id: A.task } }
      })
      const text = await r.text()
      assert(text.includes(A.task) && !text.includes('"isError":true'), text)
    })

    await test('a hook from any computer, owned or not, is processed as before', async () => {
      const lifecycle = new EventEmitter()
      const seen: unknown[] = []
      lifecycle.on('event', (e) => seen.push(e))
      const deps = {
        db,
        notifyRenderer: () => {},
        agentLifecycle: lifecycle
      } as unknown as RestApiDeps
      const r = await relayAgentHook(
        'no-such-computer',
        {
          agentId: 'claude-code',
          ctx: { v: 1, agentId: 'claude-code', taskId: A.task },
          raw: { hook_event_name: 'UserPromptSubmit', prompt: 'p', session_id: 'conv-off' }
        },
        deps,
        undefined
      )
      assert(r === 'ok' && seen.length === 1, `relayed hook: ${r}`)
      const posted = await json('/api/agent-hook', {
        method: 'POST',
        body: JSON.stringify({ agentId: 'claude-code', hookEvent: 'Stop', taskId: B.task })
      })
      assert(posted.status === 200, `posted hook: ${posted.status}`)
    })

    await test('nothing was refused or audited as a denial', () => {
      const denied = lines.filter((l) => l.event === 'authz.denied')
      assert(denied.length === 0, `${denied.length} authz.denied lines`)
    })
  } finally {
    raw.close()
    await hub.stop()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
