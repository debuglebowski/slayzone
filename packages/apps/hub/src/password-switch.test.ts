/**
 * The password switch on the hub (T-10): the REST gate refuses every password route
 * with 403 `HUB_PASSWORD_DISABLED` and one audit line, on any hub, before the bearer
 * gate. (Break-glass no longer rides the switch: break-glass.test.ts.)
 *
 *   1. `passwordRouteRefusal` / `restAuthAction` — pure.
 *   2. `withRestAuth` on a real listener: refused before the inner handler, the
 *      switch-refusal body and audit line; untouched with the switch on.
 *   3. the hub users capability refuses to create a password account when off (real
 *      hub-auth, real migrated app DB).
 *   4. the switch-refusal leaf itself (`assertHubPasswordEnabled`).
 *
 * Native ABI (the app DB is better-sqlite3 built for Electron) → Electron's node,
 * like hub-users.test.ts.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts \
 *     packages/apps/hub/src/password-switch.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { afterAll, assert, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  assertHubPasswordEnabled,
  hubPasswordEnabled,
  isHubSwitchedOffError
} from '@slayzone/platform/hub-switch-refusal'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { createHubAuth } from '@slayzone/hub-auth/server'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { createHubUsersCapability } from './hub-users.js'
import { createTrpcConnectionRegistry } from './trpc-connections.js'
import { createUserAccessRevoker } from './user-access.js'
import { passwordRouteRefusal, restAuthAction, withRestAuth } from './rest-auth.js'
import { webLogin } from './web-sessions.js'

/** The hub's revocation outside hub-auth (T-12), with no computer gateway. */
const revokerFor = (db: SlayzoneDb) =>
  createUserAccessRevoker({
    db,
    getGateway: () => null,
    connections: createTrpcConnectionRegistry()
  })

/** Collect audit lines while `fn` runs. */
async function captureAudit(fn: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const lines: Array<Record<string, unknown>> = []
  setSecurityLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>))
  try {
    await fn()
  } finally {
    setSecurityLogSink()
  }
  return lines
}

/** `withRestAuth` on a real listener with an inner handler that records whether it ran. */
async function mountGate(opts: { required: boolean; passwordEnabled?: boolean }) {
  let reached = false
  const gated = withRestAuth({
    getHubAuthRequired: () => opts.required,
    getHubAuth: () => null,
    getDb: () => null,
    ...(opts.passwordEnabled === undefined
      ? {}
      : { getPasswordEnabled: () => opts.passwordEnabled === true }),
    next: (_req, res) => {
      reached = true
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('inner')
    }
  })
  const server: Server = createServer((req, res) => gated(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('bad address')
  const base = `http://127.0.0.1:${addr.port}`
  return {
    async call(method: string, path: string, authorization?: string) {
      reached = false
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(authorization ? { authorization } : {})
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify({ email: 'a@b.c', password: 'pw' }) })
      })
      return { status: res.status, body: await res.text(), reached }
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** Every password route, with the audit event its refusal writes. */
const PASSWORD_ROUTES: Array<[method: string, path: string, event: string]> = [
  ['POST', '/api/auth/sign-in/email', 'auth.signin'],
  ['POST', '/api/auth/web-login', 'auth.signin'],
  ['POST', '/api/auth/verify-password', 'auth.signin'],
  ['POST', '/api/auth/sign-up/email', 'user.create'],
  ['POST', '/api/auth/change-password', 'auth.password.change'],
  ['POST', '/api/auth/reset-password', 'auth.password.change'],
  ['POST', '/api/auth/request-password-reset', 'auth.password.change'],
  ['GET', '/api/auth/reset-password/some-token?callbackURL=/', 'auth.password.change']
]

// --- 1. pure ---------------------------------------------------------------
test('passwordRouteRefusal: every password route when off, none when on', () => {
  for (const [, url, event] of PASSWORD_ROUTES) {
    const refusal = passwordRouteRefusal(url, false)
    assert(refusal, `${url} refused`)
    expect(refusal.event, `${url} event`).toEqual(event)
    expect(passwordRouteRefusal(url, true), `${url} untouched when on`).toBe(null)
  }
  expect(passwordRouteRefusal('/api/auth/sign-in/email', false)?.op, 'op').toBe('sign-in/email')
  expect(passwordRouteRefusal('/api/auth/sign-in/email?x=1', false)?.op, 'query').toBe(
    'sign-in/email'
  )
  expect(
    passwordRouteRefusal('/api/auth/reset-password/secret-token', false)?.route,
    'a reset token never reaches the audit route'
  ).toBe('/api/auth/reset-password/:token')
  for (const url of [
    '/api/auth/sign-out',
    '/api/auth/get-session',
    '/api/auth/sign-in/social',
    '/api/auth/callback/microsoft',
    '/api/tasks',
    '/api/hub/users',
    '/health',
    undefined
  ]) {
    expect(passwordRouteRefusal(url, false), `${String(url)} not a password route`).toBe(null)
  }
})

test('restAuthAction: off takes sign-in/email + web-login off the bootstrap allowlist', () => {
  for (const url of ['/api/auth/sign-in/email', '/api/auth/web-login']) {
    expect(restAuthAction({ hubAuthRequired: true, url }), `${url} open by default`).toBe('allow')
    expect(
      restAuthAction({ hubAuthRequired: true, passwordEnabled: true, url }),
      `${url} open with the switch on`
    ).toBe('allow')
    expect(
      restAuthAction({ hubAuthRequired: true, passwordEnabled: false, url }),
      `${url} gated with the switch off`
    ).toBe('verify')
  }
  for (const url of ['/api/auth/sign-out', '/api/auth/get-session']) {
    expect(
      restAuthAction({ hubAuthRequired: true, passwordEnabled: false, url }),
      `${url} stays open`
    ).toBe('allow')
  }
})

// --- 2. the gate on a real listener -----------------------------------------
test('off, login on: every password route 403 HUB_PASSWORD_DISABLED, never reaches a handler, one audit line', async () => {
  const gate = await mountGate({ required: true, passwordEnabled: false })
  try {
    for (const [method, path, event] of PASSWORD_ROUTES) {
      // With or without a bearer: the switch decides before the gate does.
      for (const authorization of [undefined, 'Bearer anything']) {
        const lines = await captureAudit(async () => {
          const res = await gate.call(method, path, authorization)
          expect(res.status, `${method} ${path} status`).toBe(403)
          expect(res.reached, `${path} must not reach the inner handler`).toBe(false)
          const body = JSON.parse(res.body) as { ok: boolean; code: string; error: string }
          expect(body.ok, 'ok:false').toBe(false)
          expect(body.code, 'stable code').toBe('HUB_PASSWORD_DISABLED')
          expect(body.error, `names the switch: ${body.error}`).toContain(
            'SLAYZONE_HUB_ENABLE_PASSWORD=0'
          )
        })
        expect(lines.length, `${path}: one audit line, got ${JSON.stringify(lines)}`).toBe(1)
        const line = lines[0] as {
          event: string
          outcome: string
          ip: string | null
          route: string
          detail: Record<string, unknown>
        }
        expect(line.event, `${path} event`).toEqual(event)
        expect(line.outcome, 'denied').toBe('denied')
        expect(line.ip, 'carries the client address').toBeTruthy()
        expect(line.route.startsWith(`${method} /api/auth/`), `route: ${line.route}`).toBe(true)
        expect(line.detail.code, 'detail.code').toBe('HUB_PASSWORD_DISABLED')
        expect(line.detail.variable, 'detail.variable').toBe('SLAYZONE_HUB_ENABLE_PASSWORD')
        expect(line.detail.method, 'detail.method').toBe('password')
        expect(JSON.stringify(line), 'never the email').not.toContain('a@b.c')
        expect(JSON.stringify(line), 'never a reset token').not.toContain('some-token')
      }
    }
    // Not a password route: the gate as before (401 without a bearer).
    const other = await gate.call('GET', '/api/tasks')
    expect(other.status, 'other routes keep the bearer gate').toBe(401)
    const signOut = await gate.call('POST', '/api/auth/sign-out')
    expect(signOut.status, 'sign-out still open').toBe(200)
  } finally {
    await gate.close()
  }
})

test('off, login off: refused too — the switch holds on any hub', async () => {
  const gate = await mountGate({ required: false, passwordEnabled: false })
  try {
    const res = await gate.call('POST', '/api/auth/sign-in/email')
    expect(res.status, 'refused').toBe(403)
    expect(res.reached, 'not reached').toBe(false)
    expect((await gate.call('GET', '/api/tasks')).status, 'the rest open as before').toBe(200)
  } finally {
    await gate.close()
  }
})

test('on (and absent): password routes pass exactly as before', async () => {
  for (const passwordEnabled of [true, undefined]) {
    const gate = await mountGate({ required: true, passwordEnabled })
    try {
      const lines = await captureAudit(async () => {
        for (const path of ['/api/auth/sign-in/email', '/api/auth/web-login']) {
          const res = await gate.call('POST', path)
          expect(res.status, `${path} reaches its handler`).toBe(200)
          expect(res.reached, 'reached').toBe(true)
        }
      })
      expect(lines.length, 'no audit line from the gate').toBe(0)
    } finally {
      await gate.close()
    }
  }
})

// --- 3. the hub users capability with the switch off --------------------------
const tmpDir = mkdtempSync(join(tmpdir(), 'hub-password-switch-'))
const harness = await createTestHarness()
const db: SlayzoneDb = harness.slayDb

afterAll(async () => {
  await harness.cleanup()
  rmSync(tmpDir, { recursive: true, force: true })
})

test('hub users capability: create refused with HUB_PASSWORD_DISABLED when off', async () => {
  const auth = await createHubAuth({
    dbPath: join(tmpDir, 'hub-auth.sqlite'),
    baseURL: 'http://127.0.0.1:9999',
    secret: 'hub-password-switch-test-secret-at-least-32-chars',
    enablePassword: false
  })
  const users = createHubUsersCapability(() => auth, revokerFor(db))
  let err: unknown = null
  const lines = await captureAudit(async () => {
    err = await users.create({ email: 'new@example.com' }).catch((e: unknown) => e)
  })
  expect(isHubSwitchedOffError(err), `switch refusal, got ${String(err)}`).toBe(true)
  expect((err as { code: string }).code, 'code').toBe('HUB_PASSWORD_DISABLED')
  expect(lines.length, 'one line').toBe(1)
  expect(lines[0]?.event, 'user.create').toBe('user.create')
  expect(lines[0]?.outcome, 'denied').toBe('denied')
  const signIn = await webLogin(auth, db, 'new@example.com', 'whatever-password')
  expect(signIn.ok, 'web login refused (better-auth has no password sign-in)').toBe(false)
})

// --- 4. the switch-refusal leaf ---------------------------------------------
test('assertHubPasswordEnabled: env switch by default, explicit value wins', async () => {
  const name = 'SLAYZONE_HUB_ENABLE_PASSWORD'
  const saved = process.env[name]
  try {
    delete process.env[name]
    expect(hubPasswordEnabled(), 'default on').toBe(true)
    const quiet = await captureAudit(async () => {
      assertHubPasswordEnabled('auth.signin', { op: 'x' })
    })
    expect(quiet.length, 'on: no line').toBe(0)
    process.env[name] = '0'
    expect(hubPasswordEnabled(), '0 = off').toBe(false)
    let thrown: unknown = null
    const lines = await captureAudit(async () => {
      try {
        assertHubPasswordEnabled('auth.password.change', { op: 'change-password' })
      } catch (e) {
        thrown = e
      }
    })
    expect(isHubSwitchedOffError(thrown), 'throws the switch error').toBe(true)
    expect(lines.length, 'one line').toBe(1)
    expect(lines[0]?.event, 'event').toBe('auth.password.change')
    // An explicit value beats the env (hub-auth passes its own instance's setting).
    assertHubPasswordEnabled('auth.signin', { op: 'x' }, true)
  } finally {
    if (saved === undefined) delete process.env[name]
    else process.env[name] = saved
  }
})
