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
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/owner-checks-login-off.test.ts
 */
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { TRPC_OWNER_POLICY, appRouter, checkOwnership } from '@slayzone/api'
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

describe('T-17 owner checks: the desktop app’s hub (login off) is unchanged', () => {
  let hub: Awaited<ReturnType<typeof bootInProcessHub>>
  let A: ReturnType<typeof ownedBy>
  let B: ReturnType<typeof ownedBy>
  let c: ReturnType<typeof hubClient>
  let raw: Database.Database
  let db: ReturnType<typeof createSlayzoneDbAdapter>

  beforeAll(async () => {
    hub = await bootInProcessHub({ login: false })
    // No accounts exist here; the owner columns hold what a hub with login would.
    A = ownedBy('A_SECRET', 'u-a', hub.root)
    B = ownedBy('B_OWN', 'u-b', hub.root)
    seedOwned(hub.dbPath, A)
    seedOwned(hub.dbPath, B)
    seedShared(hub.dbPath, A, B)
    c = hubClient(hub, null)
    raw = new Database(hub.dbPath)
    db = createSlayzoneDbAdapter(raw)
  })

  afterAll(async () => {
    raw?.close()
    c?.close()
    await hub?.stop()
  })

  test('the owner gate reads no rule for any procedure (no principal, no check)', async () => {
    for (const path of Object.keys(PROCS)) {
      const check = await checkOwnership({
        ctx: { db, dataRoot: hub.root, principal: null },
        path,
        type: PROCS[path]!._def.type,
        getRawInput: async () => ({ id: A.task, taskId: A.task, projectId: A.project })
      })
      expect(check, path).toBeNull()
    }
  })

  test("anyone's ids answer, with no session", async () => {
    const task = (await procedureAt(c.client, 'task.get').query({ id: A.task })) as { id: string }
    expect(task?.id, 'task.get').toBe(A.task)
    const art = (await procedureAt(c.client, 'artifacts.get').query({ id: B.artifact })) as {
      id: string
    }
    expect(art?.id, 'artifacts.get').toBe(B.artifact)
    const prompts = await procedureAt(c.client, 'agentPrompts.list').query({
      taskId: A.task,
      agentId: 'claude-code'
    })
    expect(JSON.stringify(prompts ?? null), 'agentPrompts.list').toContain('A_SECRET_PROMPT_TEXT')
  })

  test('every list holds both owners’ rows, unfiltered', async () => {
    for (const path of ['projects.list', 'task.getAll', 'task.loadBoardData', 'tags.list']) {
      const v = JSON.stringify((await procedureAt(c.client, path).query(undefined)) ?? null)
      expect(v, path).toContain(A.mark)
      expect(v, path).toContain(B.mark)
    }
    const usage = (await procedureAt(c.client, 'usageAnalytics.query').query('all')) as {
      totalInputTokens: number
    }
    // usage sums every record
    expect(usage.totalInputTokens).toBe(100_007)
    const groups = JSON.stringify(
      (await procedureAt(c.client, 'projectGroups.list').query(undefined)) ?? null
    )
    expect(groups, 'projectGroups.list').toContain(A.mark)
    expect(groups, 'projectGroups.list').toContain(B.mark)
  })

  test('every filtered subscription delivers every event, as before', async () => {
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
    expect(short, 'subscriptions missing events').toEqual([])
    const data = got['pty.onData']!.map((e) => (e as { data: string }).data)
    // pty output of every session, byte-for-byte
    expect(data).toContain('A_SECRET_TERMINAL_BYTES')
    expect(data).toContain('B_OWN_TERMINAL_BYTES')
    for (const s of subs) s.unsubscribe()
  })

  test('nothing was refused or audited as a denial', () => {
    const denied = lines.filter((l) => l.event === 'authz.denied')
    expect(denied).toEqual([])
  })
})
