/**
 * Final review round 5, R5-1: the Trash purge asks whether the computer holding a
 * task's worktree can remove it — `ready`, `wait` (not connected yet: keep the task
 * and retry on connect) or `gone` (deleted or revoked: never answers, so it must not
 * hold the purge forever). See `worktree-computer-state.ts`.
 */
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { createWorktreeComputerState } from './worktree-computer-state'

const h = await createTestHarness()
const sql = (s: string, ...p: unknown[]): void => void h.db.prepare(s).run(...p)

sql(`INSERT INTO projects (id, name, color, owner_user_id) VALUES
  ('pa', 'A', '#111', 'user-a'), ('pb', 'B', '#222', 'user-b')`)
sql(`INSERT INTO computers (id, name, platform, version, capabilities_json, created_at, owner_user_id, revoked_at)
  VALUES ('c-on', 'on', 'darwin', '1', '[]', 1, 'user-a', NULL),
         ('c-off', 'off', 'darwin', '1', '[]', 1, 'user-a', NULL),
         ('c-revoked', 'rv', 'darwin', '1', '[]', 1, 'user-a', 5)`)
sql(`INSERT INTO tasks (id, project_id, title, computer_id) VALUES
  ('t-on', 'pa', 't', 'c-on'), ('t-off', 'pa', 't', 'c-off'),
  ('t-revoked', 'pa', 't', 'c-revoked'), ('t-deleted', 'pa', 't', 'c-deleted'),
  ('t-unbound-a', 'pa', 't', NULL), ('t-unbound-b', 'pb', 't', NULL)`)

const make = (opts: { requireLogin?: boolean; usable?: string[]; pick?: string | null }) =>
  createWorktreeComputerState({
    db: h.slayDb,
    requireLogin: opts.requireLogin ?? false,
    usable: () => (opts.usable ?? []).map((computerId) => ({ computerId })),
    forTask: async () => opts.pick ?? null
  })

test('R5-1: a bound computer — ready when connected, wait when not, gone when removed', async () => {
  const state = make({ usable: ['c-on'] })
  expect(await state('t-on')).toBe('ready')
  expect(await state('t-off')).toBe('wait')
  expect(await state('t-revoked')).toBe('gone')
  expect(await state('t-deleted')).toBe('gone')
})

test('R5-1: at boot (no gateway yet) every live computer waits', async () => {
  const state = createWorktreeComputerState({
    db: h.slayDb,
    requireLogin: false,
    usable: () => {
      throw new ReferenceError('gateway not built yet')
    },
    forTask: () => {
      throw new ReferenceError('placement not built yet')
    }
  })
  expect(await state('t-on')).toBe('wait')
  expect(await state('t-unbound-a')).toBe('wait')
})

test('R5-1: unbound — the default pick when connected, else wait while a computer may return', async () => {
  expect(await make({ usable: ['c-on'], pick: 'c-on' })('t-unbound-a')).toBe('ready')
  expect(await make({})('t-unbound-a')).toBe('wait')
  // With login only the owner's computers count: user-b owns none, ever.
  expect(await make({ requireLogin: true })('t-unbound-b')).toBe('gone')
  expect(await make({ requireLogin: true })('t-unbound-a')).toBe('wait')
})
