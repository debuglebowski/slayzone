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
  isComputerOwnedBy,
  isComputerVisible,
  listVisibleComputerIds,
  ownsEveryComputerOnHost,
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
  // T-19: the hub cannot know whose machine an unowned computer is, so it is nobody's
  // to use. An admin still sees it to manage it, and a hub without login sees all.
  it("an UNOWNED computer is nobody's, but an admin manages it", async () => {
    const c = await add('legacy')
    expect(await isComputerVisible(t.db, c, { userId: 'anyone' })).toBe(false)
    expect(await isComputerVisible(t.db, c, { userId: 'anyone', isHubAdmin: true })).toBe(true)
    expect(await isComputerVisible(t.db, c, { userId: null })).toBe(true)
  })

  it('hides an owned private computer from other users', async () => {
    const c = await add('mine')
    await own(c, 'alice')
    expect(await isComputerVisible(t.db, c, { userId: 'alice' })).toBe(true)
    expect(await isComputerVisible(t.db, c, { userId: 'bob' })).toBe(false)
  })

  // O-6, T-19: strictly private. Neither stored knob opens a computer to anyone else.
  it('visibility hub opens nothing', async () => {
    const c = await add('shared-box')
    await own(c, 'alice')
    await setComputerVisibility(t.db, c, 'hub')
    expect(await isComputerVisible(t.db, c, { userId: 'bob' })).toBe(false)
    expect(await isComputerVisible(t.db, c, { userId: 'alice' })).toBe(true)
  })

  it('a grant opens nothing', async () => {
    const c = await add('mine')
    await own(c, 'alice')
    await grantComputerAccess(t.db, { computerId: c, userId: 'bob', grantedByUserId: 'alice' })
    expect(await isComputerVisible(t.db, c, { userId: 'bob' })).toBe(false)
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

// T-15: a user may manage (revoke, delete, re-scope, rename) only what they own.
describe('ownership, for the role gate', () => {
  it("isComputerOwnedBy: only the owner; an unowned or absent computer is no one's", async () => {
    const c = await add('mine')
    expect(await isComputerOwnedBy(t.db, c, 'alice')).toBe(false)
    await own(c, 'alice')
    expect(await isComputerOwnedBy(t.db, c, 'alice')).toBe(true)
    expect(await isComputerOwnedBy(t.db, c, 'bob')).toBe(false)
    expect(await isComputerOwnedBy(t.db, 'no-such-id', 'alice')).toBe(false)
  })

  it('ownsEveryComputerOnHost: every computer on the machine, and at least one', async () => {
    const a = await add('a')
    const b = await add('b')
    await t.db.run(`UPDATE computers SET host_id = 'h1' WHERE id IN (?, ?)`, [a, b])
    await own(a, 'alice')
    expect(await ownsEveryComputerOnHost(t.db, 'h1', 'alice')).toBe(false)
    await own(b, 'alice')
    expect(await ownsEveryComputerOnHost(t.db, 'h1', 'alice')).toBe(true)
    expect(await ownsEveryComputerOnHost(t.db, 'h1', 'bob')).toBe(false)
    expect(await ownsEveryComputerOnHost(t.db, 'no-such-host', 'alice')).toBe(false)
  })
})
