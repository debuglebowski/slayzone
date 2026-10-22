/**
 * Which computer work runs on, and whether it may (T-19), against a real, fully
 * migrated database: on a hub with login a computer works only for its owner — a
 * binding, an auto-pick, a caller naming one directly, the gate the routing backends
 * ask before every request — and without login nothing changes.
 *
 * Electron strict loader (better-sqlite3 native ABI), hand-rolled like
 * computer-auth.test.ts:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/computer-placement.test.ts
 */
import Database from 'better-sqlite3'
import { DB_PRAGMAS } from '@slayzone/platform'
import { runWithSecurityContext, setSecurityLogSink } from '@slayzone/platform/security-log'
import { createSlayzoneDbAdapter } from '@slayzone/test-utils'
import { runMigrations } from '@slayzone/transport/db-bootstrap'
import {
  BindComputerError,
  ComputerNotYoursError,
  createComputerPlacement,
  type UsableComputer
} from './computer-placement.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
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

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

/** The error `p` rejects with, or null when it resolves. */
async function rejection(p: Promise<unknown>): Promise<Error | null> {
  return p.then(
    () => null,
    (e: unknown) => (e instanceof Error ? e : new Error(String(e)))
  )
}

const A = 'user-a'
const B = 'user-b'

const raw = new Database(':memory:')
for (const pragma of DB_PRAGMAS) raw.pragma(pragma)
runMigrations(raw)
const db = createSlayzoneDbAdapter(raw)
const sql = (s: string, ...p: unknown[]): void => void raw.prepare(s).run(...p)

sql(
  `INSERT INTO projects (id, name, color, owner_user_id) VALUES
   ('pA', 'A', '#111', ?), ('pB', 'B', '#222', ?)`,
  A,
  B
)
sql(`INSERT INTO tasks (id, project_id, title) VALUES
  ('tA', 'pA', 'a'), ('tB', 'pB', 'b'), ('tA-boundB', 'pA', 'x'), ('tA-boundU', 'pA', 'y')`)
sql(
  `INSERT INTO computers (id, name, platform, version, capabilities_json, last_seen_at, created_at,
     owner_user_id) VALUES
   ('cA', 'a-box', 'linux-x64', '0', '{}', 0, 0, ?),
   ('cB', 'b-box', 'linux-x64', '0', '{}', 0, 0, ?),
   ('cU', 'nobodys', 'linux-x64', '0', '{}', 0, 0, NULL)`,
  A,
  B
)
sql(`UPDATE tasks SET computer_id = 'cB' WHERE id = 'tA-boundB'`)
sql(`UPDATE tasks SET computer_id = 'cU' WHERE id = 'tA-boundU'`)

let usable: UsableComputer[] = []
const placementFor = (requireLogin: boolean) =>
  createComputerPlacement({ db, requireLogin, usable: () => usable })
const as = <T>(userId: string | null, fn: () => Promise<T>): Promise<T> =>
  runWithSecurityContext({ actor: userId, ip: null, route: 'test' }, fn)

async function main(): Promise<void> {
  console.log('\ncomputer placement (T-19, real migrated DB)')
  const audit: Array<{ event: string; targetId: string | null }> = []
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as { event: string; targetId: string }))

  try {
    await test('no login (the desktop hub): today’s resolution, no gate, nothing refused', async () => {
      const p = placementFor(false)
      usable = [{ computerId: 'cA' }]
      assertEq(p.gate, undefined, 'no gate')
      assertEq(await p.forTask('tB'), 'cA', 'an unbound task takes the sole connected computer')
      assertEq(await p.forTask('tA-boundB'), 'cB', 'a binding is returned as is')
      assertEq(p.forSpec(null), 'cA', 'a spec with no computer takes the connected default')
      assertEq(await p.forProject('pB'), 'cA', 'a project takes the connected default')
      assertEq(await p.forCaller(), 'cA', 'so does a caller')
      assertEq(await p.forTarget({ computerId: 'cU' }), 'cU', 'an explicit id is returned as is')
      assertEq(await p.servesProject('cA', 'pB'), true, 'every project')
    })

    const p = placementFor(true)

    await test("an unbound task never lands on someone else's computer: bind a computer", async () => {
      usable = [{ computerId: 'cA' }]
      const err = await rejection(p.forTask('tB'))
      assertEq(err instanceof BindComputerError, true, 'BindComputerError')
      assertEq(/bind a computer/.test(err?.message ?? ''), true, err?.message ?? 'no error')
      assertEq(p.forSpec(null), null, 'and the backends never guess either')
    })

    await test("an unbound task takes its owner's connected computer", async () => {
      usable = [{ computerId: 'cA' }, { computerId: 'cB' }, { computerId: 'cU' }]
      assertEq(await p.forTask('tA'), 'cA', "A's task")
      assertEq(await p.forTask('tB'), 'cB', "B's task")
    })

    await test("a binding to someone else's (or an unowned) computer is refused and audited", async () => {
      for (const task of ['tA-boundB', 'tA-boundU']) {
        const before = audit.filter((l) => l.event === 'authz.denied').length
        const err = await rejection(p.forTask(task))
        assertEq(err instanceof ComputerNotYoursError, true, `${task}: ComputerNotYoursError`)
        assertEq(
          audit.filter((l) => l.event === 'authz.denied').length,
          before + 1,
          `${task}: one authz.denied line`
        )
      }
    })

    await test('the gate: the computer must belong to the owner of the work', async () => {
      const gate = p.gate!
      assertEq(
        await rejection(gate('cA', { kind: 'task', id: 'tA' })),
        null,
        "A's computer, A's task"
      )
      assertEq(
        (await rejection(gate('cA', { kind: 'task', id: 'tB' }))) instanceof ComputerNotYoursError,
        true,
        "A's computer, B's task"
      )
      assertEq(
        (await rejection(gate('cB', { kind: 'session', id: 'tA:tab' }))) instanceof
          ComputerNotYoursError,
        true,
        "B's computer, a session of A's task"
      )
      assertEq(
        (await rejection(gate('cU', { kind: 'task', id: 'tA' }))) !== null,
        true,
        'an unowned computer serves nobody'
      )
    })

    await test("the gate for a caller's own request: their computer, nobody else's", async () => {
      const gate = p.gate!
      assertEq(await as(A, () => rejection(gate('cA', null))), null, 'A on A’s')
      assertEq((await as(B, () => rejection(gate('cA', null)))) !== null, true, 'B on A’s')
      assertEq((await as(null, () => rejection(gate('cA', null)))) !== null, true, 'no caller')
    })

    await test('a caller naming a computer directly gets only their own', async () => {
      usable = [{ computerId: 'cA' }, { computerId: 'cB' }]
      assertEq(await as(A, () => p.forTarget({ computerId: 'cA' })), 'cA', 'A names A’s')
      assertEq(
        (await as(B, () => rejection(p.forTarget({ computerId: 'cA' })))) !== null,
        true,
        'B names A’s'
      )
      assertEq(
        (await as(A, () => rejection(p.forTarget({ computerId: 'cA', taskId: 'tB' })))) !== null,
        true,
        "A's computer for B's task"
      )
      assertEq(await as(B, () => p.forTarget({})), 'cB', "B's default is B's own")
      assertEq(await as(null, () => p.forCaller()), null, 'no caller, no computer')
    })

    await test("a project with none of its owner's computers: the warm pool skips, a request is told to bind", async () => {
      usable = [{ computerId: 'cB' }]
      assertEq(await p.forProject('pA'), null, 'warm pool: nothing to warm on')
      assertEq(
        (await rejection(p.forTarget({ projectId: 'pA' }))) instanceof BindComputerError,
        true,
        'workspace: bind a computer'
      )
    })

    await test("a computer holds only its owner's project paths", async () => {
      assertEq(await p.servesProject('cA', 'pA'), true, 'own project')
      assertEq(await p.servesProject('cA', 'pB'), false, "someone else's")
      assertEq(await p.servesProject('cU', 'pA'), false, 'unowned computer')
    })
  } finally {
    setSecurityLogSink()
    raw.close()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
