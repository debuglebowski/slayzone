/**
 * T-17, the two-user contract on a REAL hub with login (`startServer()` in this
 * process — its real auth, composition, `/trpc` socket and routers; see
 * owner-checks-harness.ts for why in-process). User A and user B are ordinary
 * accounts signed in through `/api/auth`; the admin is the hub's bootstrap owner.
 *
 *   - B gets NOT_FOUND, with one `authz.denied` line, for A's ids on EVERY id-checked
 *     procedure. The cases are generated from `TRPC_OWNER_POLICY`: one per id the
 *     policy names, so a procedure added to it is covered without editing this file.
 *     A's own call with the same input passes the gate.
 *   - B's lists hold none of A's rows: every list-filtered procedure (again from the
 *     policy), and the usage sums count B's records only.
 *   - B's subscriptions carry none of A's events while A produces them — every
 *     subscription the policy filters, fed through the hub's own emitters (pty output,
 *     chat, prompts, sessions, turns, processes, …) and A's real `task.update`
 *     (tasks changed). B's own events still arrive (so nothing is filtered blindly), and
 *     a client-supplied filter cannot widen what B sees.
 *   - The admin gets exactly what B gets of A's: nothing.
 *
 * The hub without login is `owner-checks-login-off.test.ts`; the exhaustiveness of
 * the policy is `transport/src/server/owner-policy.test.ts`.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/owner-checks.test.ts
 */
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import {
  TRPC_ADMIN_POLICY,
  TRPC_OWNER_POLICY,
  appRouter,
  checkOwnership,
  isCustomRef,
  type OwnerRule,
  type ResourceKind
} from '@slayzone/transport/server'
import { createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness.js'
import {
  BY_MUTATION,
  EMIT,
  bootInProcessHub,
  hubClient,
  ownedBy,
  procedureAt,
  seedOwned,
  seedShared,
  signedInUser,
  type Owned
} from './owner-checks-harness.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type ProcType = 'query' | 'mutation' | 'subscription'
const PROCS = appRouter._def.procedures as unknown as Record<string, { _def: { type: ProcType } }>
const typeOf = (path: string): ProcType => PROCS[path]!._def.type
/** An `admin` procedure (T-15): a user is refused by role before any id is read. */
const adminOnly = (path: string): boolean => TRPC_ADMIN_POLICY[path] === 'admin'

// ── inputs, generated from the policy ────────────────────────────────────────

/** An input carrying `id` at an IdRef path (the inverse of `valuesAt`). */
function inputAt(at: string, id: string): unknown {
  const segs = at
    .split('.')
    .flatMap((s) =>
      s.endsWith('[]') ? [s.slice(0, -2), '[]'] : s.endsWith('{}') ? [s.slice(0, -2), '{}'] : [s]
    )
    .filter((s) => s !== '')
  const build = (rest: string[]): unknown => {
    if (rest.length === 0) return id
    const [seg, ...more] = rest
    if (seg === '[]') return [build(more)]
    if (seg === '{}') return { [id]: 1 }
    return { [seg!]: build(more) }
  }
  return build(segs)
}

/** Deep-merge plain objects (for a case's id plus its `needsOne` companions). */
function merge(a: unknown, b: unknown): unknown {
  if (Array.isArray(b) || Array.isArray(a)) return b ?? a
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) }
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = merge(out[k], v)
    return out
  }
  return b ?? a
}

interface Case {
  readonly path: string
  readonly kind: ResourceKind
  readonly at: string
  /** The input naming `whose` resource at `at`. */
  input(whose: Owned, companion: Owned): unknown
}

/** One case per id the policy names. A rule with `needsOne` gets its other required
 *  ids from `companion` (the caller's own), so the case isolates the one under test. */
function idCases(): Case[] {
  const out: Case[] = []
  for (const [path, rule] of Object.entries(TRPC_OWNER_POLICY) as [string, OwnerRule][]) {
    for (const ref of rule.ids ?? []) {
      const kind = isCustomRef(ref) ? ref.sample.kind : ref.kind
      const at = isCustomRef(ref) ? '(custom)' : ref.at
      out.push({
        path,
        kind,
        at,
        input: (whose, companion) => {
          const own = isCustomRef(ref)
            ? ref.sample.input(whose[kind])
            : inputAt(ref.at, whose[kind])
          let base: unknown = {}
          for (const need of rule.needsOne ?? []) {
            if (need === at) continue
            const needRef = rule.ids?.find((r) => !isCustomRef(r) && r.at === need)
            if (needRef && !isCustomRef(needRef))
              base = merge(base, inputAt(need, companion[needRef.kind]))
          }
          return merge(base, own)
        }
      })
    }
  }
  return out
}

// ── the run ──────────────────────────────────────────────────────────────────

type Line = {
  event: string
  actor: string | null
  targetId: string | null
  detail: { reason?: string }
}
const lines: Line[] = []
setSecurityLogSink((l) => {
  try {
    lines.push(JSON.parse(l) as Line)
  } catch {
    // not ours
  }
})
const deniedLines = (path: string, actor: string): Line[] =>
  lines.filter(
    (l) =>
      l.event === 'authz.denied' &&
      l.targetId === path &&
      l.actor === actor &&
      (l.detail.reason === 'not_owner' || l.detail.reason === 'ownerless')
  )

async function call(
  client: unknown,
  path: string,
  input: unknown
): Promise<{ data?: unknown; error?: { code?: string } }> {
  const proc = procedureAt(client, path)
  const type = typeOf(path)
  if (type === 'subscription') {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sub.unsubscribe()
        resolve({ data: '(still open)' })
      }, 3_000)
      const sub = proc.subscribe(input, {
        onData: (d) => {
          clearTimeout(timer)
          sub.unsubscribe()
          resolve({ data: d })
        },
        onError: (e) => {
          clearTimeout(timer)
          resolve({ error: { code: (e as { data?: { code?: string } }).data?.code ?? String(e) } })
        }
      })
    })
  }
  try {
    const data = type === 'query' ? await proc.query(input) : await proc.mutate(input)
    return { data }
  } catch (e) {
    return { error: { code: (e as { data?: { code?: string } }).data?.code ?? String(e) } }
  }
}

describe('T-17 owner checks: two users on a real hub with login', () => {
  let hub: Awaited<ReturnType<typeof bootInProcessHub>>
  let users: { a: { userId: string; token: string }; b: { userId: string; token: string } }
  let A: Owned
  let B: Owned
  let adminId: string
  let ca: ReturnType<typeof hubClient>
  let cb: ReturnType<typeof hubClient>
  let cadmin: ReturnType<typeof hubClient>
  let raw: Database.Database
  let db: ReturnType<typeof createSlayzoneDbAdapter>
  const leaks = (v: unknown): boolean => JSON.stringify(v ?? null).includes(A.mark)

  beforeAll(async () => {
    hub = await bootInProcessHub({ login: true })
    users = {
      a: await signedInUser(hub, 'a@example.com'),
      b: await signedInUser(hub, 'b@example.com')
    }
    A = ownedBy('A_SECRET', users.a.userId, hub.root)
    B = ownedBy('B_OWN', users.b.userId, hub.root)
    seedOwned(hub.dbPath, A)
    seedOwned(hub.dbPath, B)
    seedShared(hub.dbPath, A, B)
    adminId = hub.adminUserId!
    ca = hubClient(hub, users.a.token)
    cb = hubClient(hub, users.b.token)
    cadmin = hubClient(hub, hub.adminToken)
    raw = new Database(hub.dbPath)
    db = createSlayzoneDbAdapter(raw)
  })

  afterAll(async () => {
    raw?.close()
    for (const c of [ca, cb, cadmin]) c?.close()
    await hub?.stop()
  })

  // ── 1. every id-checked procedure, every id: NOT_FOUND for B and the admin ──
  const cases = idCases()
  test(`the policy yields id cases for every id-checked procedure (${cases.length} cases)`, () => {
    const checked = Object.entries(TRPC_OWNER_POLICY).filter(([, r]) => r.mark === 'id-checked')
    const uncovered = checked.map(([path]) => path).filter((p) => !cases.some((c) => c.path === p))
    expect(uncovered).toEqual([])
    expect(cases.length).toBeGreaterThan(400)
  })

  for (const who of ['B', 'the admin'] as const) {
    test(`${who} gets NOT_FOUND + one authz.denied line for A's id on every case`, async () => {
      const [client, actor] = who === 'B' ? [cb.client, users.b.userId] : [cadmin.client, adminId]
      const wrong: string[] = []
      for (const c of cases) {
        if (actor !== adminId && adminOnly(c.path)) {
          // B is refused by role (FORBIDDEN, ADMIN_ONLY) whoever's id it names; the
          // admin, below, by owner (T-106).
          const res = await call(client, c.path, c.input(A, B))
          if (res.error?.code !== 'FORBIDDEN') wrong.push(`${c.path}: ${JSON.stringify(res)}`)
          if (leaks(res.data)) wrong.push(`${c.path}: answered with A's data`)
          continue
        }
        const before = deniedLines(c.path, actor).length
        const res = await call(client, c.path, c.input(A, actor === adminId ? A : B))
        const after = deniedLines(c.path, actor).length
        if (res.error?.code !== 'NOT_FOUND' || after !== before + 1) {
          wrong.push(
            `${c.path} [${c.at}:${c.kind}] → ${JSON.stringify(res.error ?? 'ok')} audit+${after - before}`
          )
        }
        if (leaks(res.data)) wrong.push(`${c.path}: answered with A's data`)
      }
      expect(wrong).toEqual([])
    })
  }

  test("A's own call with the same input passes the gate (in-process, no side effects)", async () => {
    const wrong: string[] = []
    for (const c of cases) {
      try {
        const check = await checkOwnership({
          ctx: {
            db,
            dataRoot: hub.root,
            principal: { userId: users.a.userId, role: 'user', scopes: ['full'] }
          },
          path: c.path,
          type: typeOf(c.path),
          getRawInput: async () => c.input(A, A)
        })
        if (!check) wrong.push(`${c.path}: no check ran`)
      } catch (e) {
        wrong.push(`${c.path} [${c.at}]: ${(e as Error).message}`)
      }
    }
    expect(wrong).toEqual([])
  })

  // ── 2. lists ──
  /** Complete inputs where an id alone is not a valid call. */
  const LIST_INPUT = (): Record<string, unknown> => ({
    'aiConfig.listItems': { scope: 'project' },
    'integrations.getConnectionUsage': { connectionId: 'conn-shared' },
    'usageAnalytics.query': 'all',
    'usageAnalytics.refresh': 'all',
    'processes.listForTask': { taskId: B.task, projectId: null },
    'projectGroups.create': { name: 'B folder' },
    'projectGroups.update': { id: B.projectGroup, name: 'B renamed' },
    'projectGroups.moveProject': {
      projectId: B.project,
      groupId: B.projectGroup,
      targetIndex: 0
    },
    'projectGroups.reorderTopLevel': { entries: [{ kind: 'project', id: B.project }] },
    'projectGroups.reorderProjectsInGroup': { groupId: B.projectGroup, projectIds: [B.project] },
    'projectGroups.createFolderWithProjects': { projectIds: [B.project] },
    'projectGroups.delete': { id: B.projectGroup },
    'task.getBlockers': { taskId: B.task },
    // Names BOTH users' tasks: each caller must get back only its own row.
    'task.loadBoardRows': { ids: [A.task, B.task] }
  })
  const listPaths = Object.entries(TRPC_OWNER_POLICY)
    .filter(([path, r]) => r.output && typeOf(path) !== 'subscription')
    .map(([path]) => path)
    // The one that deletes goes last.
    .sort((x, y) => Number(x === 'projectGroups.delete') - Number(y === 'projectGroups.delete'))
  const listInput = (path: string): unknown => {
    const inputs = LIST_INPUT()
    if (path in inputs) return inputs[path]
    const rule = TRPC_OWNER_POLICY[path]!
    let input: unknown
    for (const ref of rule.ids ?? []) {
      if (!isCustomRef(ref)) input = merge(input ?? {}, inputAt(ref.at, B[ref.kind]))
    }
    return input
  }

  // Without the filter these would show A's rows: A sees its own through them.
  const CONTROL = [
    'projects.list',
    'task.getAll',
    'task.loadBoardData',
    'task.loadBoardRows',
    'tags.list',
    'tags.getAllTaskTagIds',
    'taskTerminals.listHibernatedSessions',
    'taskTerminals.listAutoRestoreTasks',
    'projectGroups.list',
    'aiConfig.listItems',
    'integrations.getConnectionUsage',
    'usageAnalytics.query'
  ]
  test('positive control: A sees its own rows through the lists', async () => {
    for (const path of CONTROL) {
      const res = await call(ca.client, path, LIST_INPUT()[path])
      expect(
        leaks(res.data),
        `${path} shows A its rows: ${JSON.stringify(res).slice(0, 200)}`
      ).toBe(true)
    }
  })

  for (const who of ['B', 'the admin'] as const) {
    test(`${who}'s lists hold none of A's rows (${listPaths.length} list-filtered procedures)`, async () => {
      const client = who === 'B' ? cb.client : cadmin.client
      const wrong: string[] = []
      for (const path of listPaths) {
        const res = await call(client, path, listInput(path))
        if (leaks(res.data)) wrong.push(`${path}: ${JSON.stringify(res.data).slice(0, 160)}`)
      }
      expect(wrong).toEqual([])
    })
  }

  test('B still sees its own rows (the filter is not blanket)', async () => {
    const projects = (await call(cb.client, 'projects.list', undefined)).data as { id: string }[]
    // B lists its project
    expect(projects.map((p) => p.id)).toContain(B.project)
    const blockers = (await call(cb.client, 'task.getBlockers', { taskId: B.task })).data
    // A's cross-project blocker is cut
    expect(blockers).toEqual([])
  })

  test("usage sums count the caller's records only", async () => {
    const sum = async (client: unknown): Promise<number> =>
      ((await call(client, 'usageAnalytics.query', 'all')).data as { totalInputTokens: number })
        .totalInputTokens
    expect(await sum(ca.client), 'A: its own 100k').toBe(100_000)
    expect(await sum(cb.client), 'B: its own 7').toBe(7)
    expect(await sum(cadmin.client), 'admin: nothing').toBe(0)
    const board = (await call(cb.client, 'app.leaderboard.getLocalStats', undefined)).data as {
      days: { totalTokens: number }[]
    }
    const tokens = board.days.reduce((n, d) => n + d.totalTokens, 0)
    // B's leaderboard sums 7
    expect(tokens).toBe(7)
  })

  // ── 3. live streams ──
  // `admin` subscriptions (automations.onChanged, a void signal): owner-checks-admin.test.ts.
  const streamPaths = Object.entries(TRPC_OWNER_POLICY)
    .filter(([path, r]) => r.events && !adminOnly(path))
    .map(([path]) => path)
    .sort()
  test(`every filtered subscription has an event source here (${streamPaths.length})`, () => {
    const missing = streamPaths.filter((p) => !(p in EMIT) && !BY_MUTATION.includes(p))
    // no emitter for these
    expect(missing).toEqual([])
  })

  describe('live streams', () => {
    const got: Record<'b' | 'admin', Record<string, unknown[]>> = { b: {}, admin: {} }
    const subs: { unsubscribe: () => void }[] = []
    // A client-supplied filter naming A's session must not widen what B sees.
    const widened: unknown[] = []
    const clear = (): void => {
      for (const k of ['b', 'admin'] as const) for (const p of streamPaths) got[k][p] = []
    }

    beforeAll(async () => {
      const started: Promise<void>[] = []
      for (const [key, client] of [
        ['b', cb.client],
        ['admin', cadmin.client]
      ] as const) {
        for (const path of streamPaths) {
          got[key][path] = []
          started.push(
            new Promise<void>((resolve, reject) => {
              subs.push(
                procedureAt(client, path).subscribe(undefined, {
                  onStarted: () => resolve(),
                  onData: (v) => got[key][path]!.push(v),
                  onError: (e) => reject(new Error(`${path}: ${String(e)}`))
                })
              )
            })
          )
        }
      }
      await Promise.all(started)
      await new Promise<void>((resolve) => {
        subs.push(
          procedureAt(cb.client, 'pty.onData').subscribe(
            { sessionIds: [A.session] },
            { onStarted: () => resolve(), onData: (v) => widened.push(v) }
          )
        )
      })
    })

    afterAll(() => {
      for (const s of subs) s.unsubscribe()
    })

    test("B's and the admin's subscriptions carry none of A's events while A produces them", async () => {
      clear()
      for (const path of Object.keys(EMIT)) EMIT[path]!(A)
      await call(ca.client, 'task.update', { id: A.task, title: 'A_SECRET_renamed' })
      await sleep(500)
      const wrong = [
        ...streamPaths
          .filter((p) => got.b[p]!.length > 0)
          .map((p) => `B ${p}: ${JSON.stringify(got.b[p])}`),
        ...streamPaths
          .filter((p) => got.admin[p]!.length > 0)
          .map((p) => `admin ${p}: ${JSON.stringify(got.admin[p])}`)
      ]
      expect(wrong).toEqual([])
      // a sessionIds filter must not widen B's pty.onData
      expect(widened).toEqual([])
    })

    test("B's own events arrive on every one of them (the filter is not blanket); the admin's still none", async () => {
      clear()
      for (const path of Object.keys(EMIT)) EMIT[path]!(B)
      await call(cb.client, 'task.update', { id: B.task, title: 'B_OWN_renamed' })
      await sleep(500)
      const missing = streamPaths.filter((p) => got.b[p]!.length === 0)
      // B got nothing on these
      expect(missing).toEqual([])
      const adminGot = streamPaths.filter((p) => got.admin[p]!.length > 0)
      // admin got B's events on these
      expect(adminGot).toEqual([])
    })
  })
})
