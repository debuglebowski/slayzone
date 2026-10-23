/**
 * T-17 on the desktop app's own hub: login off (`SLAYZONE_SUPERVISED=1`,
 * `SLAYZONE_HUB_REQUIRE_LOGIN=0` — exactly what `sidecar-server-supervisor.ts` sets).
 * Nothing changes there: no principal, no owner check, every row of every "user"
 * lists, every event of every subscription arrives, nothing is audited.
 *
 * Same fixtures and event sources as `owner-checks.test.ts` (two "owners" that, with
 * no login, are just two projects), on a REAL hub booted in this process. Its own
 * file because the hub's registries are process-wide: one hub per process.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --experimental-loader ./packages/shared/test-utils/loader.ts \
 *   packages/apps/hub/src/owner-checks-login-off.test.ts
 */
import Database from 'better-sqlite3'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { TRPC_OWNER_POLICY, appRouter, checkOwnership } from '@slayzone/transport/server'
import { createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness.js'
import {
  BY_MUTATION,
  EMIT,
  bootInProcessHub,
  hubClient,
  ownedBy,
  procedureAt,
  seedOwned,
  seedShared
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type ProcType = 'query' | 'mutation' | 'subscription'
const PROCS = appRouter._def.procedures as unknown as Record<string, { _def: { type: ProcType } }>

const lines: { event: string }[] = []
setSecurityLogSink((l) => {
  try {
    lines.push(JSON.parse(l) as { event: string })
  } catch {
    // not ours
  }
})

async function main(): Promise<void> {
  console.log('\nT-17 owner checks: the desktop app’s hub (login off) is unchanged\n')
  const hub = await bootInProcessHub({ login: false })
  // No accounts exist here; the owner columns hold what a hub with login would.
  const A = ownedBy('A_SECRET', 'u-a', hub.root)
  const B = ownedBy('B_OWN', 'u-b', hub.root)
  seedOwned(hub.dbPath, A)
  seedOwned(hub.dbPath, B)
  seedShared(hub.dbPath, A, B)
  const c = hubClient(hub, null)
  const raw = new Database(hub.dbPath)
  const db = createSlayzoneDbAdapter(raw)
  const shows = (v: unknown, mark: string): boolean => JSON.stringify(v ?? null).includes(mark)

  try {
    await test('the owner gate reads no rule for any procedure (no principal, no check)', async () => {
      for (const path of Object.keys(PROCS)) {
        const check = await checkOwnership({
          ctx: { db, dataRoot: hub.root, principal: null },
          path,
          type: PROCS[path]!._def.type,
          getRawInput: async () => ({ id: A.task, taskId: A.task, projectId: A.project })
        })
        assert(check === null, path)
      }
    })

    await test("anyone's ids answer, with no session", async () => {
      const task = (await procedureAt(c.client, 'task.get').query({ id: A.task })) as { id: string }
      assert(task?.id === A.task, 'task.get')
      const art = (await procedureAt(c.client, 'artifacts.get').query({ id: B.artifact })) as {
        id: string
      }
      assert(art?.id === B.artifact, 'artifacts.get')
      const prompts = await procedureAt(c.client, 'agentPrompts.list').query({
        taskId: A.task,
        agentId: 'claude-code'
      })
      assert(shows(prompts, 'A_SECRET_PROMPT_TEXT'), 'agentPrompts.list')
    })

    await test('every list holds both owners’ rows, unfiltered', async () => {
      for (const path of ['projects.list', 'task.getAll', 'task.loadBoardData', 'tags.list']) {
        const v = await procedureAt(c.client, path).query(undefined)
        assert(shows(v, A.mark) && shows(v, B.mark), path)
      }
      const usage = (await procedureAt(c.client, 'usageAnalytics.query').query('all')) as {
        totalInputTokens: number
      }
      assert(
        usage.totalInputTokens === 100_007,
        `usage sums every record: ${usage.totalInputTokens}`
      )
      const groups = await procedureAt(c.client, 'projectGroups.list').query(undefined)
      assert(shows(groups, A.mark) && shows(groups, B.mark), 'projectGroups.list')
    })

    await test('every filtered subscription delivers every event, as before', async () => {
      const paths = Object.entries(TRPC_OWNER_POLICY)
        .filter(([, r]) => r.events)
        .map(([p]) => p)
      const got: Record<string, unknown[]> = {}
      const subs: { unsubscribe: () => void }[] = []
      await Promise.all(
        paths.map(
          (path) =>
            new Promise<void>((resolve, reject) => {
              got[path] = []
              subs.push(
                procedureAt(c.client, path).subscribe(undefined, {
                  onStarted: () => resolve(),
                  onData: (v) => got[path]!.push(v),
                  onError: (e) => reject(new Error(`${path}: ${String(e)}`))
                })
              )
            })
        )
      )
      for (const o of [A, B]) for (const path of Object.keys(EMIT)) EMIT[path]!(o)
      await procedureAt(c.client, 'task.update').mutate({ id: A.task, title: 'renamed' })
      await sleep(500)
      const short = paths.filter((p) => got[p]!.length < (BY_MUTATION.includes(p) ? 1 : 2))
      assert(short.length === 0, `missing events on: ${short.join(', ')}`)
      const data = got['pty.onData']!.map((e) => (e as { data: string }).data)
      assert(
        data.includes('A_SECRET_TERMINAL_BYTES') && data.includes('B_OWN_TERMINAL_BYTES'),
        'pty output of every session, byte-for-byte'
      )
      for (const s of subs) s.unsubscribe()
    })

    await test('nothing was refused or audited as a denial', () => {
      const denied = lines.filter((l) => l.event === 'authz.denied')
      assert(denied.length === 0, `${denied.length} authz.denied lines`)
    })
  } finally {
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
