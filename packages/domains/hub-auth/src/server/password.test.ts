/**
 * The password switch (T-10) against a REAL better-auth instance on a throwaway
 * node:sqlite file — no mocks.
 *
 * With `enablePassword: false`: every password endpoint 404s over HTTP, an in-process
 * sign-in is refused, `createHubUser` refuses with `HUB_PASSWORD_DISABLED` and one
 * audit line, and a password credential written while the switch was on is KEPT but
 * cannot sign in — until the switch is on again. (Break-glass is no longer part of the
 * password switch: break-glass.test.ts.)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isHubSwitchedOffError } from '@slayzone/platform/hub-switch-refusal'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHubAuth, type HubAuth } from './auth'
import { isPasswordSignInEnabled, PASSWORD_AUTH_ENDPOINTS } from './password'
import { createHubUser } from './users'

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
