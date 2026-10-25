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
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --experimental-loader ./packages/shared/test-utils/loader.ts \
 *   packages/apps/hub/src/owner-checks.test.ts
 */
import Database from 'better-sqlite3'
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

async function main(): Promise<void> {
  console.log('\nT-17 owner checks: two users on a real hub with login\n')
  const hub = await bootInProcessHub({ login: true })
  const users = {
    a: await signedInUser(hub, 'a@example.com'),
    b: await signedInUser(hub, 'b@example.com')
  }
  const A = ownedBy('A_SECRET', users.a.userId, hub.root)
  const B = ownedBy('B_OWN', users.b.userId, hub.root)
  seedOwned(hub.dbPath, A)
  seedOwned(hub.dbPath, B)
  seedShared(hub.dbPath, A, B)
  const adminId = hub.adminUserId!
  const ca = hubClient(hub, users.a.token)
  const cb = hubClient(hub, users.b.token)
  const cadmin = hubClient(hub, hub.adminToken)
  const raw = new Database(hub.dbPath)
  const db = createSlayzoneDbAdapter(raw)
  const leaks = (v: unknown): boolean => JSON.stringify(v ?? null).includes(A.mark)

  try {
    // ── 1. every id-checked procedure, every id: NOT_FOUND for B and the admin ──
    const cases = idCases()
    await test(`the policy yields id cases for every id-checked procedure (${cases.length} cases)`, () => {
      const checked = Object.entries(TRPC_OWNER_POLICY).filter(([, r]) => r.mark === 'id-checked')
      for (const [path] of checked)
        assert(
          cases.some((c) => c.path === path),
          path
        )
      assert(cases.length > 400, `${cases.length} cases`)
    })

    for (const [who, client, actor] of [
      ['B', cb.client, users.b.userId],
      ['the admin', cadmin.client, adminId]
    ] as const) {
      await test(`${who} gets NOT_FOUND + one authz.denied line for A's id on every case`, async () => {
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
        assert(wrong.length === 0, `\n      ${wrong.join('\n      ')}`)
      })
    }

    await test("A's own call with the same input passes the gate (in-process, no side effects)", async () => {
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
      assert(wrong.length === 0, `\n      ${wrong.join('\n      ')}`)
    })

    // ── 2. lists ──
    /** Complete inputs where an id alone is not a valid call. */
    const LIST_INPUT: Record<string, unknown> = {
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
    }
    const listPaths = Object.entries(TRPC_OWNER_POLICY)
      .filter(([path, r]) => r.output && typeOf(path) !== 'subscription')
      .map(([path]) => path)
      // The one that deletes goes last.
      .sort((x, y) => Number(x === 'projectGroups.delete') - Number(y === 'projectGroups.delete'))
    const listInput = (path: string): unknown => {
      if (path in LIST_INPUT) return LIST_INPUT[path]
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
    await test('positive control: A sees its own rows through the lists', async () => {
      for (const path of CONTROL) {
        const res = await call(ca.client, path, LIST_INPUT[path])
        assert(leaks(res.data), `${path} shows A its rows: ${JSON.stringify(res).slice(0, 200)}`)
      }
    })

    for (const [who, client] of [
      ['B', cb.client],
      ['the admin', cadmin.client]
    ] as const) {
      await test(`${who}'s lists hold none of A's rows (${listPaths.length} list-filtered procedures)`, async () => {
        const wrong: string[] = []
        for (const path of listPaths) {
          const res = await call(client, path, listInput(path))
          if (leaks(res.data)) wrong.push(`${path}: ${JSON.stringify(res.data).slice(0, 160)}`)
        }
        assert(wrong.length === 0, `\n      ${wrong.join('\n      ')}`)
      })
    }

    await test('B still sees its own rows (the filter is not blanket)', async () => {
      const projects = (await call(cb.client, 'projects.list', undefined)).data as { id: string }[]
      assert(
        projects.some((p) => p.id === B.project),
        'B lists its project'
      )
      const blockers = (await call(cb.client, 'task.getBlockers', { taskId: B.task }))
        .data as unknown[]
      assert(Array.isArray(blockers) && blockers.length === 0, "A's cross-project blocker is cut")
    })

    await test("usage sums count the caller's records only", async () => {
      const sum = async (client: unknown): Promise<number> =>
        ((await call(client, 'usageAnalytics.query', 'all')).data as { totalInputTokens: number })
          .totalInputTokens
      assert((await sum(ca.client)) === 100_000, 'A: its own 100k')
      assert((await sum(cb.client)) === 7, 'B: its own 7')
      assert((await sum(cadmin.client)) === 0, 'admin: nothing')
      const board = (await call(cb.client, 'app.leaderboard.getLocalStats', undefined)).data as {
        days: { totalTokens: number }[]
      }
      const tokens = board.days.reduce((n, d) => n + d.totalTokens, 0)
      assert(tokens === 7, `B's leaderboard sums 7, got ${tokens}`)
    })

    // ── 3. live streams ──
    // `admin` subscriptions (automations.onChanged, a void signal): owner-checks-admin.test.ts.
    const streamPaths = Object.entries(TRPC_OWNER_POLICY)
      .filter(([path, r]) => r.events && !adminOnly(path))
      .map(([path]) => path)
      .sort()
    await test(`every filtered subscription has an event source here (${streamPaths.length})`, () => {
      const missing = streamPaths.filter((p) => !(p in EMIT) && !BY_MUTATION.includes(p))
      assert(missing.length === 0, `no emitter for: ${missing.join(', ')}`)
    })

    const got: Record<'b' | 'admin', Record<string, unknown[]>> = { b: {}, admin: {} }
    const subs: { unsubscribe: () => void }[] = []
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
    // A client-supplied filter naming A's session must not widen what B sees.
    const widened: unknown[] = []
    await new Promise<void>((resolve) => {
      subs.push(
        procedureAt(cb.client, 'pty.onData').subscribe(
          { sessionIds: [A.session] },
          { onStarted: () => resolve(), onData: (v) => widened.push(v) }
        )
      )
    })
    const clear = (): void => {
      for (const k of ['b', 'admin'] as const) for (const p of streamPaths) got[k][p] = []
    }
    clear()

    await test("B's and the admin's subscriptions carry none of A's events while A produces them", async () => {
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
      assert(wrong.length === 0, `\n      ${wrong.join('\n      ')}`)
      assert(
        widened.length === 0,
        `a sessionIds filter widened B's pty.onData: ${JSON.stringify(widened)}`
      )
    })

    clear()
    await test("B's own events arrive on every one of them (the filter is not blanket); the admin's still none", async () => {
      for (const path of Object.keys(EMIT)) EMIT[path]!(B)
      await call(cb.client, 'task.update', { id: B.task, title: 'B_OWN_renamed' })
      await sleep(500)
      const missing = streamPaths.filter((p) => got.b[p]!.length === 0)
      assert(missing.length === 0, `B got nothing on: ${missing.join(', ')}`)
      const adminGot = streamPaths.filter((p) => got.admin[p]!.length > 0)
      assert(adminGot.length === 0, `admin got B's events on: ${adminGot.join(', ')}`)
    })

    for (const s of subs) s.unsubscribe()
  } finally {
    raw.close()
    for (const c of [ca, cb, cadmin]) c.close()
    await hub.stop()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
