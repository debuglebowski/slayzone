/**
 * T-101 / T-105 / T-106 on the desktop app's own hub: login off (`SLAYZONE_SUPERVISED=1`,
 * `SLAYZONE_HUB_REQUIRE_LOGIN=0` — what `sidecar-server-supervisor.ts` sets). Nothing
 * changes there:
 *
 *   - `exportAll` is the whole database, as before: every project, every link between
 *     them, every settings row;
 *   - an import still matches existing tags and project names across every project;
 *   - an MCP session id works from any client, and an unknown one is still a 400;
 *   - automations and the diagnostics bundle answer for every project;
 *   - nothing is refused or audited as a denial.
 *
 * The hub with login is `owner-checks-admin.test.ts`. Its own file: one hub per process.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --experimental-loader ./packages/shared/test-utils/loader.ts \
 *   packages/apps/hub/src/owner-checks-admin-login-off.test.ts
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import {
  bootInProcessHub,
  hubClient,
  ownedBy,
  procedureAt,
  seedOwned,
  seedShared,
  type InProcessHub
} from './owner-checks-harness.js'

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
const shows = (v: unknown, mark: string): boolean => JSON.stringify(v ?? null).includes(mark)

const lines: { event: string }[] = []
setSecurityLogSink((l) => {
  try {
    lines.push(JSON.parse(l) as { event: string })
  } catch {
    // not ours
  }
})

function mcpFetch(hub: InProcessHub, sid: string | null, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${hub.port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sid ? { 'mcp-session-id': sid } : {})
    },
    body: JSON.stringify(body)
  })
}

async function main(): Promise<void> {
  console.log('\nT-101/T-105/T-106: the desktop app’s hub (login off) is unchanged\n')
  const hub = await bootInProcessHub({ login: false })
  // No accounts here; the owner columns hold what a hub with login would.
  const A = ownedBy('A_SECRET', 'u-a', hub.root)
  const B = ownedBy('B_OWN', 'u-b', hub.root)
  seedOwned(hub.dbPath, A)
  seedOwned(hub.dbPath, B)
  seedShared(hub.dbPath, A, B)
  const raw = new Database(hub.dbPath)
  raw
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('integration:credential:x', 'INTERNAL_ROW')`
    )
    .run()
  const c = hubClient(hub, null)
  process.env.PLAYWRIGHT = '1'
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'slz-t101-off-')))

  try {
    await test('exportAll is the whole database, as before', async () => {
      const file = join(out, 'all.slay')
      const r = (await procedureAt(c.client, 'app.exportImport.testExportAllToPath').mutate({
        filePath: file
      })) as { success: boolean }
      assert(r.success, JSON.stringify(r))
      const data = (JSON.parse(readFileSync(file, 'utf8')) as { data: Record<string, unknown[]> })
        .data
      assert(shows(data.projects, A.mark) && shows(data.projects, B.mark), 'both projects')
      assert(shows(data.tasks, A.task) && shows(data.tasks, B.task), 'both tasks')
      assert(
        shows(data.task_dependencies, A.task) && shows(data.task_dependencies, B.task),
        'the cross-project dependency'
      )
      assert(shows(data.settings, 'INTERNAL_ROW'), 'every settings row, as before')
    })

    await test('an import matches existing tags and project names across projects, as before', async () => {
      const file = join(out, 'import.slay')
      writeFileSync(
        file,
        JSON.stringify({
          meta: { version: 1, appVersion: 't', exportDate: '', scope: 'all', dbVersion: 36 },
          data: {
            projects: [{ id: 'src-p', name: `${A.mark}_PROJECT_NAME`, color: '#000000' }],
            tasks: [{ id: 'src-t', project_id: 'src-p', title: 'imported', provider_config: '{}' }],
            tags: [{ id: 'src-tag', project_id: 'src-p', name: `${A.mark}_TAG` }],
            task_tags: [{ task_id: 'src-t', tag_id: 'src-tag' }],
            task_dependencies: [],
            terminal_tabs: [],
            ai_config_items: [],
            ai_config_project_selections: [],
            ai_config_sources: [],
            settings: []
          }
        })
      )
      const r = (await procedureAt(c.client, 'app.exportImport.testImportFromPath').mutate({
        filePath: file
      })) as { success: boolean; importedProjects: { id: string; name: string }[] }
      assert(r.success, JSON.stringify(r))
      const p = r.importedProjects[0]!
      assert(p.name === `${A.mark}_PROJECT_NAME (imported)`, `renamed on collision: ${p.name}`)
      const tag = raw
        .prepare(
          `SELECT tt.tag_id AS id FROM task_tags tt JOIN tasks t ON t.id = tt.task_id
            WHERE t.project_id = ?`
        )
        .get(p.id) as { id: string } | undefined
      assert(tag?.id === A.tag, `the existing tag reused by name: ${JSON.stringify(tag)}`)
    })

    await test('an MCP session id works from any client; an unknown one is a 400', async () => {
      const init = await mcpFetch(hub, null, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'off', version: '1' }
        }
      })
      const sid = init.headers.get('mcp-session-id')
      await init.text()
      assert(sid, `initialize: ${init.status}`)
      await (
        await mcpFetch(hub, sid, { jsonrpc: '2.0', method: 'notifications/initialized' })
      ).text()
      const list = await mcpFetch(hub, sid, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
      assert(list.status === 200 && (await list.text()).includes('create_task'), `${list.status}`)
      const unknown = await mcpFetch(hub, randomUUID(), {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list'
      })
      assert(unknown.status === 400, `unknown: ${unknown.status}`)
      await unknown.text()
    })

    await test('automations answer for every project', async () => {
      const a = await procedureAt(c.client, 'automations.get').query({ id: A.automation })
      const byB = await procedureAt(c.client, 'automations.getByProject').query({
        projectId: B.project
      })
      assert(shows(a, A.automation) && shows(byB, B.automation), 'both')
      const r = await fetch(`http://127.0.0.1:${hub.port}/api/automations/${A.automation}`)
      assert(r.status === 200 && (await r.text()).includes(A.automation), `REST: ${r.status}`)
    })

    await test('the diagnostics bundle keeps every event', async () => {
      recordDiagnosticEvent({
        level: 'info',
        source: 'server',
        event: 't101.task',
        taskId: A.task,
        message: 'A_SECRET_DIAG'
      })
      const bundle = await procedureAt(c.client, 'diagnostics.exportBundle').query({
        fromTsMs: 0,
        toTsMs: Date.now() + 60_000,
        appVersion: 't'
      })
      assert(shows(bundle, 'A_SECRET_DIAG'), 'unfiltered')
    })

    await test('nothing was refused or audited as a denial', () => {
      const denied = lines.filter((l) => l.event === 'authz.denied')
      assert(denied.length === 0, `${denied.length} authz.denied lines`)
    })
  } finally {
    delete process.env.PLAYWRIGHT
    raw.close()
    c.close()
    await hub.stop()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
