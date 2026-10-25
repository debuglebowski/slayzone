/**
 * The break-glass account (O-9, O-23) against a REAL better-auth instance on a throwaway
 * node:sqlite file — no mocks.
 *
 * One synthetic account with no credential: opened as `admin` (also on an Entra hub with
 * password sign-in off), reused, closed to a disabled `user` with its sessions revoked;
 * v1's leftover password accounts close with it. users.ts never lets anything else change
 * it, and never counts it as a human or an admin.
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OPERATOR_PROVISIONED } from './account'
import { createHubAuth, type HubAuth } from './auth'
import {
  BREAK_GLASS_EMAIL,
  closeBreakGlassAccounts,
  isBreakGlassEmail,
  listOpenBreakGlassAccounts,
  openBreakGlassAccount
} from './break-glass'
import {
  createHubUser,
  disableHubUser,
  enableHubUser,
  ensureFirstAdmin,
  findFirstAdmin,
  listHubUsers,
  setHubUserRole
} from './users'

const BASE_URL = 'http://127.0.0.1:9999'
const SECRET = 'hub-auth-break-glass-test-secret-at-least-32-chars'
const V1_EMAIL = 'break-glass-20261022-a1b2c3@hub.slayzone.local'

let tmpDir: string
let dbPath: string
let audit: Array<Record<string, unknown>>

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hub-auth-break-glass-test-'))
  dbPath = join(tmpDir, 'hub-auth.sqlite')
  audit = []
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
})

afterEach(() => {
  setSecurityLogSink()
  rmSync(tmpDir, { recursive: true, force: true })
})

/** A password hub (no Entra). */
const boot = (enablePassword = true): Promise<HubAuth> =>
  createHubAuth({ dbPath, baseURL: BASE_URL, secret: SECRET, enablePassword })

/** The Normain shape: Entra on, password off. Nothing signs in through Entra here. */
const bootSso = (enablePassword = false): Promise<HubAuth> =>
  createHubAuth({
    dbPath,
    baseURL: BASE_URL,
    secret: SECRET,
    enablePassword,
    sso: {
      tenantId: '11111111-2222-3333-4444-555555555555',
      clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      credential: {
        privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
        thumbprintS256: 'unused'
      },
      requireMfa: true
    }
  })

function count(table: string, where = '1 = 1', ...args: string[]): number {
  const db = new DatabaseSync(dbPath)
  try {
    return (
      db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...args) as {
        n: number
      }
    ).n
  } finally {
    db.close()
  }
}

const row = async (auth: HubAuth, id: string) => (await listHubUsers(auth)).find((u) => u.id === id)

describe('break-glass account', () => {
  it('recognises v2’s address and v1’s, nothing else', () => {
    expect(isBreakGlassEmail(BREAK_GLASS_EMAIL)).toBe(true)
    expect(isBreakGlassEmail(' Break-Glass@HUB.slayzone.local ')).toBe(true)
    expect(isBreakGlassEmail(V1_EMAIL)).toBe(true)
    expect(isBreakGlassEmail('owner@hub.slayzone.local')).toBe(false)
    expect(isBreakGlassEmail('break-glass@example.com')).toBe(false)
  })

  it('opens as admin with no credential on an Entra hub with password off, audited', async () => {
    const auth = await bootSso(false)
    audit.length = 0
    const { userId } = await openBreakGlassAccount(auth)
    const opened = await row(auth, userId)
    expect(opened).toMatchObject({ email: BREAK_GLASS_EMAIL, role: 'admin', disabledAt: null })
    // No `account` row at all: no password, no Entra identity — nothing to sign in with.
    expect(count('account', 'userId = ?', userId)).toBe(0)
    expect(audit).toEqual([
      expect.objectContaining({
        event: 'user.create',
        outcome: 'success',
        targetId: userId,
        detail: { role: 'admin', reason: 'break_glass' }
      })
    ])
    expect(JSON.stringify(audit)).not.toContain(BREAK_GLASS_EMAIL)
  })

  it('cannot sign in by password even with the switch on: it has no credential', async () => {
    const auth = await boot(true)
    await openBreakGlassAccount(auth)
    await expect(
      auth.api.signInEmail({ body: { email: BREAK_GLASS_EMAIL, password: 'x'.repeat(22) } })
    ).rejects.toThrow()
  })

  it('closes to a disabled `user`, sessions revoked, row kept; reopening reuses it', async () => {
    const auth = await bootSso(false)
    const { userId } = await openBreakGlassAccount(auth)
    const ctx = await auth.$context
    await ctx.internalAdapter.createSession(userId)
    expect(count('session', 'userId = ?', userId)).toBe(1)

    const revoked: string[] = []
    audit.length = 0
    const closed = await closeBreakGlassAccounts(auth, {
      revokeExternalSessions: async (id) => void revoked.push(id)
    })
    expect(closed).toEqual([userId])
    expect(revoked).toEqual([userId])
    expect(count('session', 'userId = ?', userId)).toBe(0)
    const after = await row(auth, userId)
    expect(after?.role).toBe('user')
    expect(after?.disabledAt).not.toBeNull()
    expect(audit.filter((l) => l.event === 'user.disable')).toEqual([
      expect.objectContaining({ targetId: userId, detail: { reason: 'break_glass_closed' } })
    ])
    expect(await closeBreakGlassAccounts(auth)).toEqual([])

    audit.length = 0
    const again = await openBreakGlassAccount(auth)
    expect(again.userId).toBe(userId)
    expect((await row(auth, userId))?.role).toBe('admin')
    expect(audit).toEqual([
      expect.objectContaining({
        event: 'user.enable',
        targetId: userId,
        detail: { role: 'admin', reason: 'break_glass' }
      })
    ])
    expect(count('user', 'email = ?', BREAK_GLASS_EMAIL)).toBe(1)
  })

  it('closing also closes v1’s leftover password accounts, and only break-glass ones', async () => {
    const auth = await boot(true)
    const alice = await createHubUser(auth, { email: 'alice@example.com' })
    if ('error' in alice) throw new Error(alice.error)
    // A v1 account, as T-10 left it: a password account named by its address.
    const ctx = await auth.$context
    const v1 = await ctx.internalAdapter.createUser(
      {
        email: V1_EMAIL,
        name: 'Break-glass (temporary)',
        emailVerified: true,
        role: 'user'
      },
      OPERATOR_PROVISIONED
    )
    await ctx.internalAdapter.createSession(v1.id)
    expect((await listOpenBreakGlassAccounts(auth)).map((u) => u.id)).toEqual([v1.id])

    expect(await closeBreakGlassAccounts(auth)).toEqual([v1.id])
    expect(count('session', 'userId = ?', v1.id)).toBe(0)
    expect((await row(auth, alice.id))?.disabledAt).toBeNull()
  })
})

describe('users.ts and the break-glass account', () => {
  it('disable, enable and role changes refuse it (`protected`), one denied line each', async () => {
    const auth = await boot(true)
    await createHubUser(auth, { email: 'alice@example.com' })
    await openBreakGlassAccount(auth)
    audit.length = 0
    expect(await disableHubUser(auth, BREAK_GLASS_EMAIL)).toBe('protected')
    expect(await enableHubUser(auth, BREAK_GLASS_EMAIL)).toBe('protected')
    expect(await setHubUserRole(auth, BREAK_GLASS_EMAIL, 'user')).toBe('protected')
    expect(await disableHubUser(auth, V1_EMAIL)).toBe('protected')
    expect(
      audit.map((l) => `${l.event}:${l.outcome}:${(l.detail as { reason?: string }).reason}`)
    ).toEqual([
      'user.disable:denied:break_glass',
      'user.enable:denied:break_glass',
      'user.role_change:denied:break_glass',
      'user.disable:denied:break_glass'
    ])
    expect((await listOpenBreakGlassAccounts(auth)).length).toBe(1)
  })

  it('add refuses a break-glass address', async () => {
    const auth = await boot(true)
    expect(await createHubUser(auth, { email: BREAK_GLASS_EMAIL })).toEqual({ error: 'exists' })
    expect(await createHubUser(auth, { email: V1_EMAIL })).toEqual({ error: 'exists' })
    expect(count('user', 'email = ?', BREAK_GLASS_EMAIL)).toBe(0)
  })

  it('an open break-glass admin does not count: the last real admin cannot be disabled', async () => {
    const auth = await boot(true)
    const alice = await createHubUser(auth, { email: 'alice@example.com' })
    await createHubUser(auth, { email: 'bob@example.com' })
    if ('error' in alice) throw new Error(alice.error)
    expect(alice.role).toBe('admin')
    await openBreakGlassAccount(auth)
    expect(await disableHubUser(auth, alice.email)).toBe('last-admin')
    expect(await setHubUserRole(auth, alice.email, 'user')).toBe('last-admin')
    expect(await findFirstAdmin(auth)).toBe(alice.id)
  })

  it('it is never the first admin, nor what keeps a hub from getting one', async () => {
    const auth = await boot(true)
    const { userId } = await openBreakGlassAccount(auth)
    expect(await findFirstAdmin(auth)).toBeNull()
    // The first real account still becomes admin with only break-glass open beside it.
    const alice = await createHubUser(auth, { email: 'alice@example.com' })
    if ('error' in alice) throw new Error(alice.error)
    expect(alice.role).toBe('admin')
    // ensureFirstAdmin promotes a human, never break-glass.
    const ctx = await auth.$context
    await ctx.internalAdapter.updateUser(alice.id, { role: 'user' })
    expect(await ensureFirstAdmin(auth)).toBe(alice.id)
    expect((await row(auth, userId))?.role).toBe('admin')
  })

  it('an Entra hub demotes a break-glass admin a crash left open at its next boot', async () => {
    const first = await bootSso(false)
    const { userId } = await openBreakGlassAccount(first)
    const next = await bootSso(false)
    expect((await row(next, userId))?.role).toBe('user')
  })
})
