/**
 * Which computer work runs on, and whether it may (T-19), against a real, fully
 * migrated database: on a hub with login a computer works only for its owner — a
 * binding, an auto-pick, a caller naming one directly, the gate the routing backends
 * ask before every request — and without login nothing changes.
 *
 * vitest under Electron's node (better-sqlite3 native ABI):
 * packages/shared/test-utils/vitest.harness.config.ts
 */
import { afterAll, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import { DB_PRAGMAS } from '@slayzone/platform'
import { runWithSecurityContext, setSecurityLogSink } from '@slayzone/platform/security-log'
import { createSlayzoneDbAdapter } from '@slayzone/test-utils'
import { runMigrations } from '@slayzone/db-migrations'
import {
  BindComputerError,
  ComputerNotYoursError,
  createComputerPlacement,
  type UsableComputer
} from './computer-placement.js'

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

const audit: Array<{ event: string; targetId: string | null }> = []
setSecurityLogSink((line) => audit.push(JSON.parse(line) as { event: string; targetId: string }))

afterAll(async () => {
  setSecurityLogSink()
  raw.close()
})

test('no login (the desktop hub): today’s resolution, no gate, nothing refused', async () => {
  const p = placementFor(false)
  usable = [{ computerId: 'cA' }]
  expect(p.gate, 'no gate').toBeUndefined()
  expect(await p.forTask('tB'), 'an unbound task takes the sole connected computer').toBe('cA')
  expect(await p.forTask('tA-boundB'), 'a binding is returned as is').toBe('cB')
  expect(p.forSpec(null), 'a spec with no computer takes the connected default').toBe('cA')
  expect(await p.forProject('pB'), 'a project takes the connected default').toBe('cA')
  expect(await p.forCaller(), 'so does a caller').toBe('cA')
  expect(await p.forTarget({ computerId: 'cU' }), 'an explicit id is returned as is').toBe('cU')
  expect(await p.servesProject('cA', 'pB'), 'every project').toBe(true)
})

const p = placementFor(true)

test("an unbound task never lands on someone else's computer: bind a computer", async () => {
  usable = [{ computerId: 'cA' }]
  const err = await rejection(p.forTask('tB'))
  expect(err instanceof BindComputerError, 'BindComputerError').toBe(true)
  expect(/bind a computer/.test(err?.message ?? ''), err?.message ?? 'no error').toBe(true)
  expect(p.forSpec(null), 'and the backends never guess either').toBeNull()
})

test("an unbound task takes its owner's connected computer", async () => {
  usable = [{ computerId: 'cA' }, { computerId: 'cB' }, { computerId: 'cU' }]
  expect(await p.forTask('tA'), "A's task").toBe('cA')
  expect(await p.forTask('tB'), "B's task").toBe('cB')
})

test("a binding to someone else's (or an unowned) computer is refused and audited", async () => {
  for (const task of ['tA-boundB', 'tA-boundU']) {
    const before = audit.filter((l) => l.event === 'authz.denied').length
    const err = await rejection(p.forTask(task))
    expect(err instanceof ComputerNotYoursError, `${task}: ComputerNotYoursError`).toBe(true)
    expect(
      audit.filter((l) => l.event === 'authz.denied').length,
      `${task}: one authz.denied line`
    ).toBe(before + 1)
  }
})

test('the gate: the computer must belong to the owner of the work', async () => {
  const gate = p.gate!
  expect(await rejection(gate('cA', { kind: 'task', id: 'tA' })), "A's computer, A's task").toBe(
    null
  )
  expect(
    (await rejection(gate('cA', { kind: 'task', id: 'tB' }))) instanceof ComputerNotYoursError,
    "A's computer, B's task"
  ).toBe(true)
  expect(
    (await rejection(gate('cB', { kind: 'session', id: 'tA:tab' }))) instanceof
      ComputerNotYoursError,
    "B's computer, a session of A's task"
  ).toBe(true)
  expect(
    (await rejection(gate('cU', { kind: 'task', id: 'tA' }))) !== null,
    'an unowned computer serves nobody'
  ).toBe(true)
})

test("the gate for a caller's own request: their computer, nobody else's", async () => {
  const gate = p.gate!
  expect(await as(A, () => rejection(gate('cA', null))), 'A on A’s').toBeNull()
  expect((await as(B, () => rejection(gate('cA', null)))) !== null, 'B on A’s').toBe(true)
  expect((await as(null, () => rejection(gate('cA', null)))) !== null, 'no caller').toBe(true)
})

test('a caller naming a computer directly gets only their own', async () => {
  usable = [{ computerId: 'cA' }, { computerId: 'cB' }]
  expect(await as(A, () => p.forTarget({ computerId: 'cA' })), 'A names A’s').toBe('cA')
  expect(
    (await as(B, () => rejection(p.forTarget({ computerId: 'cA' })))) !== null,
    'B names A’s'
  ).toBe(true)
  expect(
    (await as(A, () => rejection(p.forTarget({ computerId: 'cA', taskId: 'tB' })))) !== null,
    "A's computer for B's task"
  ).toBe(true)
  expect(await as(B, () => p.forTarget({})), "B's default is B's own").toBe('cB')
  expect(await as(null, () => p.forCaller()), 'no caller, no computer').toBeNull()
})

test("a project with none of its owner's computers: the warm pool skips, a request is told to bind", async () => {
  usable = [{ computerId: 'cB' }]
  expect(await p.forProject('pA'), 'warm pool: nothing to warm on').toBeNull()
  expect(
    (await rejection(p.forTarget({ projectId: 'pA' }))) instanceof BindComputerError,
    'workspace: bind a computer'
  ).toBe(true)
})

test("a computer holds only its owner's project paths", async () => {
  expect(await p.servesProject('cA', 'pA'), 'own project').toBe(true)
  expect(await p.servesProject('cA', 'pB'), "someone else's").toBe(false)
  expect(await p.servesProject('cU', 'pA'), 'unowned computer').toBe(false)
})
