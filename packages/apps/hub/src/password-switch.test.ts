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
 * Native ABI (the app DB is better-sqlite3 built for Electron) → Electron strict loader,
 * hand-rolled harness like hub-users.test.ts.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/password-switch.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
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

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
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

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

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

async function main(): Promise<void> {
  console.log('\nhub password switch (T-10) + break-glass (O-9)')
  console.log('─'.repeat(48))

  // --- 1. pure ---------------------------------------------------------------
  await test('passwordRouteRefusal: every password route when off, none when on', () => {
    for (const [, url, event] of PASSWORD_ROUTES) {
      const refusal = passwordRouteRefusal(url, false)
      assert(refusal, `${url} refused`)
      assertEq(refusal.event, event, `${url} event`)
      assertEq(passwordRouteRefusal(url, true), null, `${url} untouched when on`)
    }
    assertEq(passwordRouteRefusal('/api/auth/sign-in/email', false)?.op, 'sign-in/email', 'op')
    assertEq(
      passwordRouteRefusal('/api/auth/sign-in/email?x=1', false)?.op,
      'sign-in/email',
      'query'
    )
    assertEq(
      passwordRouteRefusal('/api/auth/reset-password/secret-token', false)?.route,
      '/api/auth/reset-password/:token',
      'a reset token never reaches the audit route'
    )
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
      assertEq(passwordRouteRefusal(url, false), null, `${String(url)} not a password route`)
    }
  })

  await test('restAuthAction: off takes sign-in/email + web-login off the bootstrap allowlist', () => {
    for (const url of ['/api/auth/sign-in/email', '/api/auth/web-login']) {
      assertEq(restAuthAction({ hubAuthRequired: true, url }), 'allow', `${url} open by default`)
      assertEq(
        restAuthAction({ hubAuthRequired: true, passwordEnabled: true, url }),
        'allow',
        `${url} open with the switch on`
      )
      assertEq(
        restAuthAction({ hubAuthRequired: true, passwordEnabled: false, url }),
        'verify',
        `${url} gated with the switch off`
      )
    }
    for (const url of ['/api/auth/sign-out', '/api/auth/get-session']) {
      assertEq(
        restAuthAction({ hubAuthRequired: true, passwordEnabled: false, url }),
        'allow',
        `${url} stays open`
      )
    }
  })

  // --- 2. the gate on a real listener -----------------------------------------
  await test('off, login on: every password route 403 HUB_PASSWORD_DISABLED, never reaches a handler, one audit line', async () => {
    const gate = await mountGate({ required: true, passwordEnabled: false })
    try {
      for (const [method, path, event] of PASSWORD_ROUTES) {
        // With or without a bearer: the switch decides before the gate does.
        for (const authorization of [undefined, 'Bearer anything']) {
          const lines = await captureAudit(async () => {
            const res = await gate.call(method, path, authorization)
            assertEq(res.status, 403, `${method} ${path} status`)
            assert(!res.reached, `${path} must not reach the inner handler`)
            const body = JSON.parse(res.body) as { ok: boolean; code: string; error: string }
            assertEq(body.ok, false, 'ok:false')
            assertEq(body.code, 'HUB_PASSWORD_DISABLED', 'stable code')
            assert(
              body.error.includes('SLAYZONE_HUB_ENABLE_PASSWORD=0'),
              `names the switch: ${body.error}`
            )
          })
          assertEq(lines.length, 1, `${path}: one audit line, got ${JSON.stringify(lines)}`)
          const line = lines[0] as {
            event: string
            outcome: string
            ip: string | null
            route: string
            detail: Record<string, unknown>
          }
          assertEq(line.event, event, `${path} event`)
          assertEq(line.outcome, 'denied', 'denied')
          assert(line.ip, 'carries the client address')
          assert(line.route.startsWith(`${method} /api/auth/`), `route: ${line.route}`)
          assertEq(line.detail.code, 'HUB_PASSWORD_DISABLED', 'detail.code')
          assertEq(line.detail.variable, 'SLAYZONE_HUB_ENABLE_PASSWORD', 'detail.variable')
          assertEq(line.detail.method, 'password', 'detail.method')
          assert(!JSON.stringify(line).includes('a@b.c'), 'never the email')
          assert(!JSON.stringify(line).includes('some-token'), 'never a reset token')
        }
      }
      // Not a password route: the gate as before (401 without a bearer).
      const other = await gate.call('GET', '/api/tasks')
      assertEq(other.status, 401, 'other routes keep the bearer gate')
      const signOut = await gate.call('POST', '/api/auth/sign-out')
      assertEq(signOut.status, 200, 'sign-out still open')
    } finally {
      await gate.close()
    }
  })

  await test('off, login off: refused too — the switch holds on any hub', async () => {
    const gate = await mountGate({ required: false, passwordEnabled: false })
    try {
      const res = await gate.call('POST', '/api/auth/sign-in/email')
      assertEq(res.status, 403, 'refused')
      assert(!res.reached, 'not reached')
      assertEq((await gate.call('GET', '/api/tasks')).status, 200, 'the rest open as before')
    } finally {
      await gate.close()
    }
  })

  await test('on (and absent): password routes pass exactly as before', async () => {
    for (const passwordEnabled of [true, undefined]) {
      const gate = await mountGate({ required: true, passwordEnabled })
      try {
        const lines = await captureAudit(async () => {
          for (const path of ['/api/auth/sign-in/email', '/api/auth/web-login']) {
            const res = await gate.call('POST', path)
            assertEq(res.status, 200, `${path} reaches its handler`)
            assert(res.reached, 'reached')
          }
        })
        assertEq(lines.length, 0, 'no audit line from the gate')
      } finally {
        await gate.close()
      }
    }
  })

  // --- 3. the hub users capability with the switch off --------------------------
  const tmpDir = mkdtempSync(join(tmpdir(), 'hub-password-switch-'))
  const harness = await createTestHarness()
  const db: SlayzoneDb = harness.slayDb

  try {
    await test('hub users capability: create refused with HUB_PASSWORD_DISABLED when off', async () => {
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
      assert(isHubSwitchedOffError(err), `switch refusal, got ${String(err)}`)
      assertEq((err as { code: string }).code, 'HUB_PASSWORD_DISABLED', 'code')
      assertEq(lines.length, 1, 'one line')
      assertEq(lines[0]?.event, 'user.create', 'user.create')
      assertEq(lines[0]?.outcome, 'denied', 'denied')
      const signIn = await webLogin(auth, db, 'new@example.com', 'whatever-password')
      assert(!signIn.ok, 'web login refused (better-auth has no password sign-in)')
    })
  } finally {
    await harness.cleanup()
    rmSync(tmpDir, { recursive: true, force: true })
  }

  // --- 4. the switch-refusal leaf ---------------------------------------------
  await test('assertHubPasswordEnabled: env switch by default, explicit value wins', async () => {
    const name = 'SLAYZONE_HUB_ENABLE_PASSWORD'
    const saved = process.env[name]
    try {
      delete process.env[name]
      assertEq(hubPasswordEnabled(), true, 'default on')
      const quiet = await captureAudit(async () => {
        assertHubPasswordEnabled('auth.signin', { op: 'x' })
      })
      assertEq(quiet.length, 0, 'on: no line')
      process.env[name] = '0'
      assertEq(hubPasswordEnabled(), false, '0 = off')
      let thrown: unknown = null
      const lines = await captureAudit(async () => {
        try {
          assertHubPasswordEnabled('auth.password.change', { op: 'change-password' })
        } catch (e) {
          thrown = e
        }
      })
      assert(isHubSwitchedOffError(thrown), 'throws the switch error')
      assertEq(lines.length, 1, 'one line')
      assertEq(lines[0]?.event, 'auth.password.change', 'event')
      // An explicit value beats the env (hub-auth passes its own instance's setting).
      assertHubPasswordEnabled('auth.signin', { op: 'x' }, true)
    } finally {
      if (saved === undefined) delete process.env[name]
      else process.env[name] = saved
    }
  })

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
