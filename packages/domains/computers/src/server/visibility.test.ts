/**
 * Computer visibility. Every case here is a code-execution boundary: binding a
 * task to a computer runs an agent in that computer's `$HOME`, so a hole in this
 * predicate is not a disclosure bug, it is arbitrary execution in another user's
 * account.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertComputerVisible,
  claimComputer,
  grantComputerAccess,
  isComputerVisible,
  listVisibleComputerIds,
  revokeComputerAccess,
  setComputerVisibility
} from './visibility'
import { registerComputer, resolveTaskComputerIdOrDefault } from './store'
import { createMigratedDb, seedProjectAndTask, type TestDb } from './test-db'

let t: TestDb
beforeEach(() => {
  t = createMigratedDb()
})
afterEach(() => t.close())

const add = async (name: string): Promise<string> =>
  (await registerComputer(t.db, { name, platform: 'darwin-arm64', version: '0.36.0' })).id

const own = async (id: string, userId: string): Promise<void> => {
  await t.db.run(`UPDATE computers SET owner_user_id = ? WHERE id = ?`, [userId, id])
}

describe('visibility', () => {
  // Every row is unowned today — v161 deliberately did not backfill. Hiding them
  // would strand every existing install behind a claim nobody knows to perform.
  it('shows an UNOWNED computer to everyone', async () => {
    const c = await add('legacy')
    expect(await isComputerVisible(t.db, c, { userId: 'anyone' })).toBe(true)
  })

  it('hides an owned private computer from other users', async () => {
    const c = await add('mine')
    await own(c, 'alice')
    expect(await isComputerVisible(t.db, c, { userId: 'alice' })).toBe(true)
    expect(await isComputerVisible(t.db, c, { userId: 'bob' })).toBe(false)
  })

  it('shows an owned computer to everyone once visibility is hub', async () => {
    const c = await add('shared-box')
    await own(c, 'alice')
    await setComputerVisibility(t.db, c, 'hub')
    expect(await isComputerVisible(t.db, c, { userId: 'bob' })).toBe(true)
  })

  it('honours an explicit grant, and its removal', async () => {
    const c = await add('mine')
    await own(c, 'alice')
    await grantComputerAccess(t.db, { computerId: c, userId: 'bob', grantedByUserId: 'alice' })
    expect(await isComputerVisible(t.db, c, { userId: 'bob' })).toBe(true)
    await revokeComputerAccess(t.db, c, 'bob')
    expect(await isComputerVisible(t.db, c, { userId: 'bob' })).toBe(false)
  })

  it('shows everything to a hub admin', async () => {
    const c = await add('mine')
    await own(c, 'alice')
    expect(await isComputerVisible(t.db, c, { userId: 'bob', isHubAdmin: true })).toBe(true)
  })

  // A supervised hub has no user identity and exactly one human; gating there
  // would break the desktop app for no gain.
  it('does not filter when there is no user (supervised hub)', async () => {
    const c = await add('mine')
    await own(c, 'alice')
    expect(await isComputerVisible(t.db, c, { userId: null })).toBe(true)
  })

  it('excludes revoked computers from the visible set', async () => {
    const c = await add('gone')
    await t.db.run(`UPDATE computers SET revoked_at = 1 WHERE id = ?`, [c])
    expect((await listVisibleComputerIds(t.db, { userId: 'alice' })).has(c)).toBe(false)
  })
})

describe('assertComputerVisible', () => {
  it('throws for a computer the viewer cannot see', async () => {
    const c = await add('mine')
    await own(c, 'alice')
    await expect(assertComputerVisible(t.db, c, { userId: 'bob' })).rejects.toThrow(
      /no such computer/
    )
  })

  // The message must not distinguish "exists but hidden" from "does not exist" —
  // the difference would confirm an id to someone with no access to it.
  it('gives the same error for a nonexistent id', async () => {
    await expect(assertComputerVisible(t.db, 'nope', { userId: 'bob' })).rejects.toThrow(
      /no such computer/
    )
  })

  // Unbinding can only ever narrow, so it needs no permission.
  it('allows null (unbind)', async () => {
    await expect(assertComputerVisible(t.db, null, { userId: 'bob' })).resolves.toBeUndefined()
  })
})

describe('claimComputer', () => {
  it('claims an unowned computer and refuses to reassign an owned one', async () => {
    const c = await add('legacy')
    expect(await claimComputer(t.db, c, 'alice')).toBe(true)
    expect(await claimComputer(t.db, c, 'bob')).toBe(false)
    expect(await isComputerVisible(t.db, c, { userId: 'bob' })).toBe(false)
  })
})

describe('resolveTaskComputerIdOrDefault', () => {
  // The auto-select was the subtlest hole: with one connected computer it was
  // returned to ANY caller, so a task could land on a machine belonging to
  // someone else without anyone binding anything.
  it('never auto-selects a computer the viewer cannot see', async () => {
    seedProjectAndTask(t.raw, 'proj-v', 'task-v')
    const taskId = 'task-v'
    const c = await add('alices-box')
    await own(c, 'alice')
    const connected = (): Array<{ computerId: string; name?: string }> => [{ computerId: c }]

    expect(await resolveTaskComputerIdOrDefault(t.db, taskId, connected, { userId: 'alice' })).toBe(
      c
    )
    expect(
      await resolveTaskComputerIdOrDefault(t.db, taskId, connected, { userId: 'bob' })
    ).toBeNull()
    // No viewer = supervised hub, where filtering would be wrong.
    expect(await resolveTaskComputerIdOrDefault(t.db, taskId, connected)).toBe(c)
  })
})
