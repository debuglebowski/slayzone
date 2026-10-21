/**
 * Security audit lines from hub-auth (T-03) against a REAL better-auth instance on a
 * throwaway node:sqlite file: sign-in success and failure, sessions created, revoked,
 * expired and signed out, password change, and the operator account commands. Every
 * case also asserts what must NOT appear: the password, the session token, the email.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHubAuth, type HubAuth } from './auth'
import {
  createHubUser,
  disableHubUser,
  enableHubUser,
  ensureFirstAdmin,
  setHubUserRole,
  type CreatedHubUser
} from './users'

let tmpDir: string
let auth: HubAuth
let audit: Array<Record<string, unknown>>

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hub-auth-audit-test-'))
  auth = await createHubAuth({
    dbPath: join(tmpDir, 'hub-auth.sqlite'),
    baseURL: 'http://127.0.0.1:9999',
    secret: 'hub-auth-test-secret-at-least-32-chars-long'
  })
  audit = []
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
})

afterEach(() => {
  setSecurityLogSink()
  rmSync(tmpDir, { recursive: true, force: true })
})

const events = (): string[] => audit.map((l) => `${l.event}:${l.outcome}`)

async function create(email: string): Promise<CreatedHubUser> {
  const result = await createHubUser(auth, { email })
  if ('error' in result) throw new Error(`expected creation to succeed, got ${result.error}`)
  return result
}

describe('sign-in', () => {
  it('a wrong password writes auth.signin failure with a code and a subject ref, never the email or password', async () => {
    await create('alice@example.com')
    audit.length = 0
    await expect(
      auth.api.signInEmail({ body: { email: 'alice@example.com', password: 'wrong-password-123' } })
    ).rejects.toThrow()
    expect(events()).toEqual(['auth.signin:failure'])
    const detail = audit[0]!.detail as Record<string, unknown>
    expect(audit[0]!.actor).toBeNull()
    expect(detail.method).toBe('password')
    expect(detail.reason).toBe('INVALID_EMAIL_OR_PASSWORD')
    expect(detail.subjectRef).toMatch(/^[0-9a-f]{16}$/)
    const text = JSON.stringify(audit)
    expect(text).not.toContain('alice@example.com')
    expect(text).not.toContain('wrong-password-123')
  })

  it('the subject ref is the same for repeated failures against one account', async () => {
    for (const password of ['wrong-1-xxxxxxxx', 'wrong-2-xxxxxxxx']) {
      await auth.api
        .signInEmail({ body: { email: 'Bob@Example.com ', password } })
        .catch(() => undefined)
    }
    await auth.api
      .signInEmail({ body: { email: 'carol@example.com', password: 'wrong-3-xxxxxxxx' } })
      .catch(() => undefined)
    const refs = audit.map((l) => (l.detail as { subjectRef: string }).subjectRef)
    expect(refs[0]).toBe(refs[1])
    expect(refs[2]).not.toBe(refs[0])
  })

  it('a good password writes auth.signin + auth.session.create naming the user, never the token', async () => {
    const user = await create('dave@example.com')
    audit.length = 0
    const signedIn = await auth.api.signInEmail({
      body: { email: 'dave@example.com', password: user.password }
    })
    expect(events().sort()).toEqual(['auth.session.create:success', 'auth.signin:success'])
    for (const l of audit) expect(l.actor).toBe(user.id)
    const session = audit.find((l) => l.event === 'auth.session.create')!
    expect(session.targetKind).toBe('session')
    expect(session.targetId).toEqual(expect.any(String))
    const text = JSON.stringify(audit)
    expect(text).not.toContain(signedIn.token)
    expect(text).not.toContain(user.password)
  })
})

describe('sessions', () => {
  async function signIn(email: string): Promise<{ user: CreatedHubUser; token: string }> {
    const user = await create(email)
    const signedIn = await auth.api.signInEmail({ body: { email, password: user.password } })
    return { user, token: signedIn.token }
  }
  const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` })

  it('sign-out writes auth.signout naming the user', async () => {
    const { user, token } = await signIn('erin@example.com')
    audit.length = 0
    await auth.api.signOut({ headers: bearer(token) })
    expect(events()).toEqual(['auth.signout:success'])
    expect(audit[0]!.actor).toBe(user.id)
    expect(JSON.stringify(audit)).not.toContain(token)
  })

  it('revoking every session writes auth.session.revoke per session', async () => {
    const { user, token } = await signIn('frank@example.com')
    await auth.api.signInEmail({ body: { email: 'frank@example.com', password: user.password } })
    audit.length = 0
    await auth.api.revokeSessions({ headers: bearer(token) })
    expect(events()).toEqual(['auth.session.revoke:success', 'auth.session.revoke:success'])
    for (const l of audit) expect((l.detail as { userId: string }).userId).toBe(user.id)
  })

  it('an expired session removed on lookup writes auth.session.expire, not a revoke', async () => {
    const { token } = await signIn('gina@example.com')
    const db = new DatabaseSync(join(tmpDir, 'hub-auth.sqlite'))
    db.prepare('UPDATE session SET expiresAt = ?').run(new Date(Date.now() - 60_000).toISOString())
    db.close()
    audit.length = 0
    expect(await auth.api.getSession({ headers: bearer(token) })).toBeNull()
    expect(events()).toEqual(['auth.session.expire:success'])
  })

  it('a password change writes auth.password.change, never either password', async () => {
    const { user, token } = await signIn('hank@example.com')
    audit.length = 0
    await auth.api.changePassword({
      headers: bearer(token),
      body: { currentPassword: user.password, newPassword: 'brand-new-password-456' }
    })
    expect(events()).toContain('auth.password.change:success')
    const line = audit.find((l) => l.event === 'auth.password.change')!
    expect(line.actor).toBe(user.id)
    const text = JSON.stringify(audit)
    expect(text).not.toContain(user.password)
    expect(text).not.toContain('brand-new-password-456')
  })
})

describe('operator account commands', () => {
  it('add writes user.create; a duplicate writes a failure; never the email or password', async () => {
    const user = await create('ivy@example.com')
    await createHubUser(auth, { email: 'ivy@example.com' })
    expect(events()).toEqual(['user.create:success', 'user.create:failure'])
    expect(audit[0]!.targetKind).toBe('user')
    expect(audit[0]!.targetId).toBe(user.id)
    expect((audit[1]!.detail as { reason: string }).reason).toBe('exists')
    const text = JSON.stringify(audit)
    expect(text).not.toContain('ivy@example.com')
    expect(text).not.toContain(user.password)
  })

  it('disable writes the revoked sessions and user.disable; refusals are denied', async () => {
    const keep = await create('jack@example.com')
    const gone = await create('kim@example.com')
    await auth.api.signInEmail({ body: { email: 'kim@example.com', password: gone.password } })
    audit.length = 0

    expect(await disableHubUser(auth, 'kim@example.com')).toBe('ok')
    expect(await disableHubUser(auth, 'nobody@example.com')).toBe('not-found')
    expect(await disableHubUser(auth, 'jack@example.com')).toBe('last-user')
    expect(events()).toEqual([
      'auth.session.revoke:success',
      'user.disable:success',
      'user.disable:failure',
      'user.disable:denied'
    ])
    expect(audit[1]!.targetId).toBe(gone.id)
    expect((audit[2]!.detail as { reason: string }).reason).toBe('not_found')
    expect(audit[3]!.targetId).toBe(keep.id)
    expect((audit[3]!.detail as { reason: string }).reason).toBe('last_user')
    expect(JSON.stringify(audit)).not.toContain('@example.com')
  })

  it('enable and role change write user.enable and user.role_change with the role', async () => {
    const admin = await create('lea@example.com')
    const other = await create('max@example.com')
    await disableHubUser(auth, 'max@example.com')
    audit.length = 0

    expect(await enableHubUser(auth, 'max@example.com')).toBe('ok')
    expect(await setHubUserRole(auth, 'max@example.com', 'admin')).toBe('ok')
    expect(await setHubUserRole(auth, 'max@example.com', 'user')).toBe('ok')
    expect(await setHubUserRole(auth, 'lea@example.com', 'user')).toBe('last-admin')
    expect(events()).toEqual([
      'user.enable:success',
      'user.role_change:success',
      'user.role_change:success',
      'user.role_change:denied'
    ])
    expect(audit[0]!.targetId).toBe(other.id)
    expect(audit[1]!.detail).toEqual({ role: 'admin' })
    expect(audit[2]!.detail).toEqual({ role: 'user' })
    expect(audit[3]!.targetId).toBe(admin.id)
    expect(audit[3]!.detail).toEqual({ reason: 'last_admin', role: 'user' })
    expect(JSON.stringify(audit)).not.toContain('@example.com')
  })

  it('the boot promotion of a first admin writes user.role_change with reason first_admin', async () => {
    const first = await create('nina@example.com')
    await create('omar@example.com')
    const db = new DatabaseSync(join(tmpDir, 'hub-auth.sqlite'))
    db.prepare('UPDATE user SET role = NULL').run()
    db.close()
    audit.length = 0
    expect(await ensureFirstAdmin(auth)).toBe(first.id)
    expect(await ensureFirstAdmin(auth)).toBeNull()
    expect(events()).toEqual(['user.role_change:success'])
    expect(audit[0]!.targetId).toBe(first.id)
    expect(audit[0]!.actor).toBeNull()
    expect(audit[0]!.detail).toEqual({ reason: 'first_admin', role: 'admin' })
  })

  it('a disabled account signing in writes ONE auth.signin denied line, never the email or password', async () => {
    await create('pia@example.com')
    const user = await create('quinn@example.com')
    await disableHubUser(auth, 'quinn@example.com')
    audit.length = 0
    await expect(
      auth.api.signInEmail({ body: { email: 'quinn@example.com', password: user.password } })
    ).rejects.toMatchObject({ body: { code: 'ACCOUNT_DISABLED' } })
    expect(events()).toEqual(['auth.signin:denied'])
    expect(audit[0]!.actor).toBeNull()
    expect(audit[0]!.targetKind).toBe('user')
    expect(audit[0]!.targetId).toBe(user.id)
    expect(audit[0]!.detail).toEqual({ reason: 'account_disabled', endpoint: '/sign-in/email' })
    const text = JSON.stringify(audit)
    expect(text).not.toContain('quinn@example.com')
    expect(text).not.toContain(user.password)
  })
})
