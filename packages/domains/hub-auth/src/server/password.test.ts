/**
 * The password switch (T-10) and break-glass accounts (O-9) against a REAL better-auth
 * instance on a throwaway node:sqlite file — no mocks.
 *
 * With `enablePassword: false`: every password endpoint 404s over HTTP, an in-process
 * sign-in is refused, `createHubUser` refuses with `HUB_PASSWORD_DISABLED` and one
 * audit line, and a password credential written while the switch was on is KEPT but
 * cannot sign in — until the switch is on again. Break-glass: the account is `user`
 * (also on an Entra hub), signs in, and closing it disables it and revokes its sessions
 * even when it is the last enabled account.
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isHubSwitchedOffError } from '@slayzone/platform/hub-switch-refusal'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHubAuth, type HubAuth } from './auth'
import {
  closeBreakGlassAccounts,
  createBreakGlassAccount,
  isBreakGlassEmail,
  listOpenBreakGlassAccounts
} from './break-glass'
import { isPasswordSignInEnabled, PASSWORD_AUTH_ENDPOINTS } from './password'
import { createHubUser, listHubUsers } from './users'

const BASE_URL = 'http://127.0.0.1:9999'
const SECRET = 'hub-auth-password-test-secret-at-least-32-chars'

let tmpDir: string
let dbPath: string
let audit: Array<Record<string, unknown>>

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hub-auth-password-test-'))
  dbPath = join(tmpDir, 'hub-auth.sqlite')
  audit = []
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
})

afterEach(() => {
  setSecurityLogSink()
  rmSync(tmpDir, { recursive: true, force: true })
})

const boot = (enablePassword?: boolean): Promise<HubAuth> =>
  createHubAuth({
    dbPath,
    baseURL: BASE_URL,
    secret: SECRET,
    ...(enablePassword === undefined ? {} : { enablePassword })
  })

/** An Entra hub. Nothing here signs in through Entra, so the key is never used. */
const bootSso = (enablePassword: boolean): Promise<HubAuth> =>
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

const post = (auth: HubAuth, path: string, body: unknown = {}) =>
  auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify(body)
    })
  )

/** Rows of one table, straight from the sqlite file. */
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

async function created(auth: HubAuth, email: string) {
  const result = await createHubUser(auth, { email })
  if ('error' in result) throw new Error(`expected an account, got ${result.error}`)
  return result
}

describe('password switch off', () => {
  it('defaults on: the desktop hub and any hub that does not set it', async () => {
    expect(isPasswordSignInEnabled(await boot())).toBe(true)
  })

  it('every password endpoint 404s over HTTP; sign-out and get-session do not', async () => {
    const auth = await boot(false)
    expect(isPasswordSignInEnabled(auth)).toBe(false)
    for (const path of Object.keys(PASSWORD_AUTH_ENDPOINTS)) {
      const res = await post(auth, path, { email: 'a@example.com', password: 'x'.repeat(16) })
      expect(res.status, path).toBe(404)
    }
    const session = await auth.handler(new Request(`${BASE_URL}/api/auth/get-session`))
    expect(session.status).toBe(200)
  })

  it('the same endpoints are served with the switch on (only off disables them)', async () => {
    const auth = await boot(true)
    const res = await post(auth, '/sign-in/email', {
      email: 'nobody@example.com',
      password: 'x'.repeat(16)
    })
    expect(res.status).toBe(401)
  })

  it('createHubUser refuses with HUB_PASSWORD_DISABLED, one audit line, no row', async () => {
    const auth = await boot(false)
    const users = count('user')
    audit.length = 0
    const err = await createHubUser(auth, { email: 'new@example.com' }).catch((e: unknown) => e)
    expect(isHubSwitchedOffError(err)).toBe(true)
    expect((err as { code: string }).code).toBe('HUB_PASSWORD_DISABLED')
    expect((err as Error).message).toContain('SLAYZONE_HUB_ENABLE_PASSWORD=0')
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      event: 'user.create',
      outcome: 'denied',
      detail: {
        op: 'create',
        code: 'HUB_PASSWORD_DISABLED',
        variable: 'SLAYZONE_HUB_ENABLE_PASSWORD'
      }
    })
    expect(count('user')).toBe(users)
  })

  it('a credential from before is kept, cannot sign in while off, and works again when on', async () => {
    const before = await boot(true)
    const alice = await created(before, 'alice@example.com')
    const credentialRows = () =>
      count('account', "userId = ? AND providerId = 'credential'", alice.id)
    expect(credentialRows()).toBe(1)

    const off = await boot(false)
    await expect(
      off.api.signInEmail({ body: { email: alice.email, password: alice.password } })
    ).rejects.toThrow(/not enabled/i)
    const http = await post(off, '/sign-in/email', { email: alice.email, password: alice.password })
    expect(http.status).toBe(404)
    expect(credentialRows()).toBe(1)
    expect(count('session', 'userId = ?', alice.id)).toBe(0)

    const on = await boot(true)
    const signedIn = await on.api.signInEmail({
      body: { email: alice.email, password: alice.password }
    })
    expect(signedIn.user.id).toBe(alice.id)
  })
})

describe('break-glass accounts', () => {
  it('recognises only its own addresses', () => {
    expect(isBreakGlassEmail('break-glass-20261022-a1b2c3@hub.slayzone.local')).toBe(true)
    expect(isBreakGlassEmail('Break-Glass-20261022-A1B2C3@hub.slayzone.local')).toBe(true)
    expect(isBreakGlassEmail('owner@hub.slayzone.local')).toBe(false)
    expect(isBreakGlassEmail('break-glass-x@example.com')).toBe(false)
  })

  it('on an Entra hub with password on: a `user` account that signs in, audited break_glass', async () => {
    const auth = await bootSso(true)
    audit.length = 0
    const account = await createBreakGlassAccount(auth, new Date('2026-10-22T08:00:00Z'))
    expect(account.role).toBe('user')
    expect(account.email).toMatch(/^break-glass-20261022-[0-9a-f]{6}@hub\.slayzone\.local$/)
    expect(audit).toEqual([
      expect.objectContaining({
        event: 'user.create',
        outcome: 'success',
        targetId: account.id,
        detail: { role: 'user', reason: 'break_glass' }
      })
    ])
    const signedIn = await auth.api.signInEmail({
      body: { email: account.email, password: account.password }
    })
    expect(signedIn.user.id).toBe(account.id)
    expect((await listOpenBreakGlassAccounts(auth)).map((u) => u.id)).toEqual([account.id])
    // Never in an audit line: the address or the password.
    const lines = JSON.stringify(audit)
    expect(lines).not.toContain(account.email)
    expect(lines).not.toContain(account.password)
  })

  it('a fresh address each time, so a closed one never collides', async () => {
    const auth = await bootSso(true)
    const a = await createBreakGlassAccount(auth)
    const b = await createBreakGlassAccount(auth)
    expect(a.email).not.toBe(b.email)
  })

  it('cannot be created with password sign-in off', async () => {
    const auth = await bootSso(false)
    const err = await createBreakGlassAccount(auth).catch((e: unknown) => e)
    expect(isHubSwitchedOffError(err)).toBe(true)
    expect(await listOpenBreakGlassAccounts(auth)).toEqual([])
  })

  it('closing disables it and revokes its sessions — even as the last account — and keeps every row', async () => {
    const open = await bootSso(true)
    const account = await createBreakGlassAccount(open)
    await open.api.signInEmail({ body: { email: account.email, password: account.password } })
    expect(count('session', 'userId = ?', account.id)).toBe(1)

    const closing = await bootSso(false)
    const revoked: string[] = []
    audit.length = 0
    const closed = await closeBreakGlassAccounts(closing, {
      revokeExternalSessions: async (userId) => void revoked.push(userId)
    })
    expect(closed).toEqual([account.id])
    expect(revoked).toEqual([account.id])
    expect(count('session', 'userId = ?', account.id)).toBe(0)
    expect(count('user', 'id = ?', account.id)).toBe(1)
    expect(count('account', 'userId = ?', account.id)).toBe(1)
    // One line for the account (and better-auth's own per-session revoke lines).
    expect(audit.filter((l) => l.event === 'user.disable')).toEqual([
      expect.objectContaining({
        event: 'user.disable',
        outcome: 'success',
        targetId: account.id,
        detail: { reason: 'break_glass_closed' }
      })
    ])
    expect((await listHubUsers(closing)).find((u) => u.id === account.id)?.disabledAt).not.toBe(
      null
    )
    // Idempotent: nothing left to close.
    expect(await closeBreakGlassAccounts(closing)).toEqual([])

    // Password on again: the closed account still cannot sign in (it is disabled).
    const reopened = await bootSso(true)
    await expect(
      reopened.api.signInEmail({ body: { email: account.email, password: account.password } })
    ).rejects.toThrow()
  })

  it('closing leaves every other account alone', async () => {
    const auth = await boot(true)
    const alice = await created(auth, 'alice@example.com')
    await createBreakGlassAccount(auth)
    await closeBreakGlassAccounts(auth)
    const row = (await listHubUsers(auth)).find((u) => u.id === alice.id)
    expect(row?.disabledAt).toBeNull()
  })
})
