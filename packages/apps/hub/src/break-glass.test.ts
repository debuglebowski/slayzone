/**
 * Break-glass v2 (O-9, O-23) over a REAL hub-auth (the Normain shape: Entra on, password
 * off), the real migrated app DB, the real local socket, and a mini hub: the real REST
 * gate (`withRestAuth`) in front of the real REST route table (`createMcpRestApp`) and the
 * redemption route, on a real listener. The clock and the TTL timer are fakes.
 *
 *   grant (socket, operator command) → redeem (verifier, once, within 10 min) → an admin
 *   session that disables a user and revokes a computer, and reaches nothing else (no
 *   content route, no `/mcp`, no join token, no account creation, not its own role, no
 *   `/trpc`, no new grant) → it ends at its TTL, on the end command, or on its own
 *   DELETE; boot closes what a crash left and removes v1's file; login off has none of
 *   it; nothing secret on disk or in a log line.
 *
 * Native ABI (the app DB is better-sqlite3 built for Electron) → Electron strict loader,
 * hand-rolled harness like leavers.test.ts.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/break-glass.test.ts
 */
import { generateKeyPairSync } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getComputer, registerComputer } from '@slayzone/computers/server'
import {
  BREAK_GLASS_EMAIL,
  createHubAuth,
  ENTRA_PROVIDER_ID,
  type HubAuth,
  listHubUsers,
  openBreakGlassAccount
} from '@slayzone/hub-auth/server'
import type { SlayzoneDb } from '@slayzone/platform'
import { adoptClientAddress, parseTrustedProxies } from '@slayzone/platform/client-address'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { createMcpRestApp } from '@slayzone/transport/server'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import {
  BREAK_GLASS_GRANT_TTL_MS,
  BREAK_GLASS_PATH,
  type BreakGlass,
  breakGlassChallenge,
  createBreakGlass,
  handleBreakGlassRequest
} from './break-glass.js'
import { runBreakGlassCommand } from './break-glass-command.js'
import { resolveHubAdminSocketPath, startHubAdminSocket } from './hub-admin-socket.js'
import { resolveConnectionPrincipal } from './hub-trpc-context.js'
import { createHubUsersCapability } from './hub-users.js'
import { verifyRestBearer, withRestAuth } from './rest-auth.js'
import { createTrpcConnectionRegistry } from './trpc-connections.js'
import { createUserAccessRevoker } from './user-access.js'

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
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`)
}

/** A fresh verifier/challenge pair, as `slay hub break-glass start` makes one. */
let verifierSeq = 0
function pair(): { verifier: string; challenge: string } {
  const verifier = `test-verifier-${String(++verifierSeq).padStart(4, '0')}-${'x'.repeat(30)}`
  return { verifier, challenge: breakGlassChallenge(verifier) }
}

const OPERATOR = { osUser: 'azureuser', uid: 0, sudoUser: null }

/** One audit line, as the sink receives it. */
interface AuditLine {
  event: string
  outcome: string
  level: string
  actor: string | null
  ip: string | null
  detail: Record<string, unknown>
}

/** A JSON reply from the mini hub. */
interface Reply {
  status: number
  body: { token: string; code?: string; email?: string; expiresAt?: string; error?: string }
}

async function main(): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'hub-break-glass-'))
  const dataRoot = join(tmpDir, 'root')
  mkdirSync(dataRoot, { recursive: true })
  const audit: AuditLine[] = []
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as AuditLine))
  const logs: string[] = []
  const log = (m: string): void => void logs.push(m)

  const harness = await createTestHarness()
  const db: SlayzoneDb = harness.slayDb
  const auth: HubAuth = await createHubAuth({
    dbPath: join(tmpDir, 'hub-auth.sqlite'),
    baseURL: 'http://127.0.0.1:9999',
    secret: 'hub-break-glass-test-secret-at-least-32-chars',
    enablePassword: false,
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
  // Two people, as Entra would have made them (password is off).
  const ctx = await auth.$context
  const alice = await ctx.internalAdapter.createUser(
    {
      email: 'alice@example.com',
      name: 'Alice',
      emailVerified: true,
      role: 'admin'
    },
    { method: 'oauth', oauth: { providerId: ENTRA_PROVIDER_ID } }
  )
  const bob = await ctx.internalAdapter.createUser(
    {
      email: 'bob@example.com',
      name: 'Bob',
      emailVerified: true,
      role: 'user'
    },
    { method: 'oauth', oauth: { providerId: ENTRA_PROVIDER_ID } }
  )
  await registerComputer(db, { id: 'c-laptop', name: 'laptop', platform: 'p', version: '0' })

  const dropped: string[] = []
  const gateway = {
    disconnect: (id: string): boolean => dropped.push(id) > 0,
    listComputers: () => [],
    listUsableComputers: () => []
  }
  const userAccess = createUserAccessRevoker({
    db,
    getGateway: () => gateway,
    connections: createTrpcConnectionRegistry(),
    log
  })

  let now = Date.parse('2026-10-22T10:00:00Z')
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  const breakGlass: BreakGlass = createBreakGlass({
    getAuth: () => auth,
    requireLogin: true,
    revokeUser: (id) => userAccess.revokeUser(id),
    now: () => now,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false }
      timers.push(timer)
      return { cancel: () => void (timer.cancelled = true) }
    },
    log
  })

  // The mini hub: client address (one trusted front end) → gate → break-glass route or
  // the real REST app.
  const mcpRest = createMcpRestApp({
    db,
    notifyRenderer: () => undefined,
    computers: { getHubUrl: () => 'ws://127.0.0.1:1/computers', getGateway: () => gateway },
    hubUsers: createHubUsersCapability(() => auth, userAccess),
    restAuth: {
      required: () => true,
      verifyBearer: (headers, cookies) => verifyRestBearer(auth, db, headers, cookies, breakGlass)
    }
  })
  const proxies = parseTrustedProxies('127.0.0.1')
  assert(proxies.ok, 'trusted proxies parse')
  const gated = withRestAuth({
    getHubAuthRequired: () => true,
    getSsoActive: () => true,
    getPasswordEnabled: () => false,
    getHubAuth: () => auth,
    getDb: () => db,
    getBreakGlass: () => breakGlass,
    next: (req, res) => {
      if ((req.url ?? '').split('?')[0] === BREAK_GLASS_PATH && breakGlass.enabled()) {
        handleBreakGlassRequest(breakGlass, req, res)
        return
      }
      mcpRest.app(req, res)
    }
  })
  const server: Server = createServer((req, res) => {
    adoptClientAddress(req, proxies.value)
    gated(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {}
  ): Promise<Reply> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.9',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {})
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) })
    })
    const text = await res.text()
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      /* text */
    }
    return { status: res.status, body: body as Reply['body'] }
  }
  const redeemHttp = (verifier: string) => call('POST', BREAK_GLASS_PATH, { body: { verifier } })
  const account = async () => (await listHubUsers(auth)).find((u) => u.email === BREAK_GLASS_EMAIL)
  const io = () => {
    const out: string[] = []
    const err: string[] = []
    return { out, err, sink: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }
  }
  const socketPath = resolveHubAdminSocketPath(dataRoot)
  assert(socketPath, 'socket path')
  const secrets: string[] = []

  try {
    await test('login off: break-glass is off — no grant, no redemption, idle', async () => {
      const off = createBreakGlass({
        getAuth: () => auth,
        requireLogin: false,
        revokeUser: async () => undefined
      })
      assertEq(off.enabled(), false, 'disabled')
      const g = await off.grant({ challenge: pair().challenge, by: OPERATOR })
      assert(!g.ok && g.code === 'unavailable', 'grant unavailable')
      const r = await off.redeem({ verifier: pair().verifier, ip: null })
      assert(!r.ok && r.reason === 'unavailable', 'redeem unavailable')
      assertEq(off.status(), { state: 'idle' }, 'idle')
    })

    await test('the operator command refuses where no hub serves break-glass (login off, not running)', async () => {
      const empty = join(tmpDir, 'e')
      mkdirSync(empty)
      const { err, sink } = io()
      const code = await runBreakGlassCommand(['status', '--root', empty], sink)
      assertEq(code, 1, 'exit 1')
      assert(err.join('\n').includes('does not require login'), err.join('\n'))
    })

    const adminSocket = await startHubAdminSocket({ socketPath, breakGlass, log })
    assert(adminSocket, 'socket started')
    try {
      await test('the channel: 0600 socket in a 0700 directory', () => {
        assertEq(statSync(socketPath).mode & 0o777, 0o600, 'socket 0600')
        assertEq(statSync(join(dataRoot, 'run')).mode & 0o777, 0o700, 'dir 0700')
      })

      await test('grant validation: a malformed challenge or TTL opens nothing', async () => {
        const { err, sink } = io()
        assertEq(
          await runBreakGlassCommand(['open', '--challenge', 'short', '--root', dataRoot], sink),
          1,
          'bad challenge refused'
        )
        assert(err.join('\n').includes('43-character'), err.join('\n'))
        const ttl = await breakGlass.grant({
          challenge: pair().challenge,
          ttlMs: 3 * 60 * 60_000,
          by: OPERATOR
        })
        assert(!ttl.ok && ttl.code === 'invalid', 'ttl over 2h refused')
        assertEq(breakGlass.status(), { state: 'idle' }, 'still idle')
      })

      let session = ''
      const first = pair()
      secrets.push(first.verifier)
      await test('open over the socket: a pending grant, audited with the operator, nothing secret printed', async () => {
        const { out, sink } = io()
        audit.length = 0
        const code = await runBreakGlassCommand(
          ['open', '--challenge', first.challenge, '--ttl', '30m', '--root', dataRoot],
          sink
        )
        assertEq(code, 0, 'exit 0')
        const status = breakGlass.status()
        assert(status.state === 'pending', 'pending')
        assert(out.join('\n').includes(status.ref), 'output names the grant')
        assert(!out.join('\n').includes(first.verifier), 'output holds no verifier')
        const grant = audit.find((l) => l.event === 'auth.break_glass.grant')
        assert(grant && grant.outcome === 'success' && grant.level === 'warn', 'grant line')
        assertEq(grant.detail.grantRef, status.ref, 'grantRef')
        assert(typeof grant.detail.osUser === 'string', 'osUser recorded')
        assertEq(grant.detail.ttlSec, 1800, 'ttl')
        assert(!JSON.stringify(audit).includes(first.challenge), 'challenge not logged')
        const { out: st, sink: stSink } = io()
        assertEq(await runBreakGlassCommand(['status', '--root', dataRoot], stSink), 0, 'status')
        assert(st.join('\n').includes('waiting to be redeemed'), st.join('\n'))
      })

      await test('redeem: a wrong verifier is refused and leaves the grant; the right one opens an admin session', async () => {
        audit.length = 0
        const wrong = await redeemHttp(pair().verifier)
        assertEq(wrong.status, 403, 'wrong verifier 403')
        assertEq(wrong.body.code, 'BREAK_GLASS_REFUSED', 'one refusal code')
        assertEq(breakGlass.status().state, 'pending', 'grant kept')
        assertEq((await account())?.disabledAt ?? 'none', 'none', 'no account yet')

        const ok = await redeemHttp(first.verifier)
        assertEq(ok.status, 200, `redeemed: ${JSON.stringify(ok.body)}`)
        session = ok.body.token
        secrets.push(session)
        assert(/^szbg_[A-Za-z0-9_-]{43}$/.test(session), 'szbg_ token')
        assertEq(ok.body.email, BREAK_GLASS_EMAIL, 'as the break-glass account')
        assertEq(ok.body.expiresAt, new Date(now + 30 * 60_000).toISOString(), 'TTL from now')
        const row = await account()
        assert(row && row.role === 'admin' && row.disabledAt === null, 'account open as admin')
        assertEq(breakGlass.status().state, 'active', 'active')
        const denied = audit.find(
          (l) => l.event === 'auth.break_glass.redeem' && l.outcome === 'denied'
        )
        assertEq(denied?.detail.reason, 'mismatch', 'mismatch audited')
        assertEq(denied?.ip, '203.0.113.9', 'client address (T-22)')
        const redeemed = audit.find(
          (l) => l.event === 'auth.break_glass.redeem' && l.outcome === 'success'
        )
        assertEq(redeemed?.ip, '203.0.113.9', 'redeem ip is the resolved client')
        assertEq(redeemed?.actor, row.id, 'actor is the break-glass account')
        const all = `${JSON.stringify(audit)}\n${logs.join('\n')}`
        assert(!all.includes(session) && !all.includes(first.verifier), 'no secret in any line')
      })

      await test('works once: the same verifier again is refused; no new grant while it is open', async () => {
        audit.length = 0
        const again = await redeemHttp(first.verifier)
        assertEq(again.status, 403, 'second use 403')
        assertEq(
          audit.find((l) => l.event === 'auth.break_glass.redeem')?.detail.reason,
          'used',
          'audited as used'
        )
        const { err, sink } = io()
        const code = await runBreakGlassCommand(
          ['open', '--challenge', pair().challenge, '--root', dataRoot],
          sink
        )
        assertEq(code, 1, 'second grant refused')
        assert(err.join('\n').includes('end it first'), err.join('\n'))
      })

      await test('the session disables a user and revokes a computer, attributed to it', async () => {
        const id = (await account())!.id
        audit.length = 0
        const disabled = await call('PATCH', '/api/hub/users', {
          token: session,
          body: { email: 'bob@example.com', disabled: true }
        })
        assertEq(disabled.status, 200, `disable: ${JSON.stringify(disabled.body)}`)
        assert((await listHubUsers(auth)).find((u) => u.id === bob.id)?.disabledAt, 'bob disabled')
        const listed = await call('GET', '/api/hub/users', { token: session })
        assertEq(listed.status, 200, 'list users')
        const revoked = await call('PATCH', '/api/hub/computers', {
          token: session,
          body: { id: 'c-laptop', revoked: true }
        })
        assertEq(revoked.status, 200, `revoke: ${JSON.stringify(revoked.body)}`)
        assert((await getComputer(db, 'c-laptop'))?.revoked_at, 'computer revoked')
        assert(dropped.includes('c-laptop'), 'its connection dropped')
        const computers = await call('GET', '/api/computers', { token: session })
        assertEq(computers.status, 200, 'list computers')
        const disable = audit.find((l) => l.event === 'user.disable' && l.outcome === 'success')
        assertEq(disable?.actor, id, 'user.disable by the break-glass account')
        const revoke = audit.find((l) => l.event === 'computer.revoke')
        assertEq(revoke?.actor, id, 'computer.revoke by the break-glass account')
        assertEq(
          audit.filter((l) => l.event === 'auth.break_glass.use').length,
          4,
          'one use line per request'
        )
      })

      await test('…and reaches nothing else: content, /mcp, join tokens, accounts, its role, /trpc, grants', async () => {
        audit.length = 0
        const refused: Array<[string, string, unknown?]> = [
          ['GET', '/api/tasks'],
          ['GET', '/api/projects'],
          ['GET', '/api/pty/x/buffer'],
          ['POST', '/mcp', {}],
          ['POST', '/api/computers/join-token', { label: 'mine' }],
          ['POST', '/api/hub/users', { email: 'new@example.com' }],
          ['POST', BREAK_GLASS_PATH, { verifier: pair().verifier }]
        ]
        for (const [method, path, body] of refused) {
          const r = await call(method, path, { token: session, body })
          assertEq(r.status, 403, `${method} ${path}`)
        }
        assertEq(
          audit.filter((l) => l.event === 'authz.denied' && l.detail.reason === 'break_glass')
            .length,
          refused.length,
          'each refusal audited break_glass'
        )
        const ownRole = await call('PATCH', '/api/hub/users', {
          token: session,
          body: { email: BREAK_GLASS_EMAIL, role: 'user' }
        })
        assertEq(ownRole.status, 409, 'its own role: refused (Entra hub: roles are Entra’s)')
        const ownDisable = await call('PATCH', '/api/hub/users', {
          token: session,
          body: { email: BREAK_GLASS_EMAIL, disabled: true }
        })
        assertEq(ownDisable.status, 409, 'itself: protected')
        assert(String(ownDisable.body.error).includes('break-glass'), String(ownDisable.body.error))
        assertEq(
          await resolveConnectionPrincipal({
            hubAuthRequired: true,
            hubAuth: auth,
            db,
            token: session
          }),
          null,
          '/trpc never accepts it'
        )
        assertEq(breakGlass.status().state, 'active', 'still the one session')
      })

      await test('TTL: refused at expiry even before the timer runs; the timer closes the account', async () => {
        const timer = timers.at(-1)
        assert(timer && !timer.cancelled && timer.ms === 30 * 60_000, 'a 30 min timer')
        now += 30 * 60_000
        assertEq(await breakGlass.resolve(session), null, 'refused at expiry')
        const after = await call('GET', '/api/hub/users', { token: session })
        assertEq(after.status, 401, 'expired token 401')
        timer.fn()
        for (let i = 0; i < 50 && (await account())?.disabledAt === null; i++) {
          await new Promise((r) => setTimeout(r, 10))
        }
        const row = await account()
        assert(row?.disabledAt && row.role === 'user', 'closed: disabled user')
        assertEq(breakGlass.status(), { state: 'idle' }, 'idle')
        const end = audit.filter((l) => l.event === 'auth.break_glass.end').at(-1)
        assertEq(end?.detail.reason, 'expired', 'end expired')
        assert(
          (await listHubUsers(auth)).find((u) => u.id === bob.id)?.disabledAt,
          'bob stays disabled'
        )
      })

      await test('the end command ends a session: account closed, token refused', async () => {
        const p = pair()
        assert((await breakGlass.grant({ challenge: p.challenge, by: OPERATOR })).ok, 'grant')
        const r = await redeemHttp(p.verifier)
        assertEq(r.status, 200, 'redeemed')
        const { out, sink } = io()
        assertEq(await runBreakGlassCommand(['end', '--root', dataRoot], sink), 0, 'end ok')
        assert(out.join('\n').includes('session ended'), out.join('\n'))
        assertEq(await breakGlass.resolve(r.body.token), null, 'token refused')
        assertEq((await call('GET', '/api/hub/users', { token: r.body.token })).status, 401, '401')
        assert((await account())?.disabledAt, 'account closed')
        const end = audit.filter((l) => l.event === 'auth.break_glass.end').at(-1)
        assertEq(end?.detail.reason, 'ended', 'end reason')
        assert(typeof end?.detail.osUser === 'string', 'who ended it')
        // Once means once: after the session, its verifier redeems nothing either.
        assertEq((await redeemHttp(p.verifier)).status, 403, 'the old verifier is dead')
        assertEq(breakGlass.status(), { state: 'idle' }, 'nothing reopened')
      })

      await test('the session can end itself (DELETE); another bearer cannot', async () => {
        const p = pair()
        assert((await breakGlass.grant({ challenge: p.challenge, by: OPERATOR })).ok, 'grant')
        const r = await redeemHttp(p.verifier)
        assertEq(
          (await call('DELETE', BREAK_GLASS_PATH, { token: 'szbg_nope' })).status,
          401,
          '401'
        )
        assertEq(breakGlass.status().state, 'active', 'still open')
        const del = await call('DELETE', BREAK_GLASS_PATH, { token: r.body.token })
        assertEq(del.status, 200, 'ended')
        assertEq(breakGlass.status(), { state: 'idle' }, 'idle')
        assert((await account())?.disabledAt, 'account closed')
      })

      await test('a grant nobody redeems expires after 10 minutes', async () => {
        const p = pair()
        assert((await breakGlass.grant({ challenge: p.challenge, by: OPERATOR })).ok, 'grant')
        now += BREAK_GLASS_GRANT_TTL_MS
        assertEq(breakGlass.status(), { state: 'idle' }, 'expired grant is not shown')
        audit.length = 0
        assertEq((await redeemHttp(p.verifier)).status, 403, 'expired refused')
        assertEq(
          audit.find((l) => l.event === 'auth.break_glass.redeem')?.detail.reason,
          'expired',
          'audited as expired'
        )
      })

      await test('racing redemptions consume a grant once', async () => {
        const p = pair()
        assert((await breakGlass.grant({ challenge: p.challenge, by: OPERATOR })).ok, 'grant')
        const results = await Promise.all([redeemHttp(p.verifier), redeemHttp(p.verifier)])
        assertEq(results.map((r) => r.status).sort(), [200, 403], 'one wins')
        await breakGlass.end('ended')
      })

      await test('stop closes an open session (server.ts calls end at stop)', async () => {
        const p = pair()
        assert((await breakGlass.grant({ challenge: p.challenge, by: OPERATOR })).ok, 'grant')
        assertEq((await redeemHttp(p.verifier)).status, 200, 'redeemed')
        const ended = await breakGlass.end('stop')
        assertEq(ended, { grant: false, session: true }, 'session ended')
        assert((await account())?.disabledAt, 'account closed')
      })
    } finally {
      await adminSocket.close()
    }

    await test('the socket is gone after close, and the command says so', async () => {
      assert(!existsSync(socketPath), 'socket removed')
      const { err, sink } = io()
      assertEq(await runBreakGlassCommand(['end', '--root', dataRoot], sink), 1, 'exit 1')
      assert(err.join('\n').includes('No hub with break-glass'), err.join('\n'))
    })

    await test('boot: v1’s file removed, leftover accounts (v2 and v1) closed, audited, idempotent', async () => {
      const v1File = join(dataRoot, 'hub.break-glass.json')
      writeFileSync(v1File, JSON.stringify({ userId: 'x', password: 'v1-secret' }), { mode: 0o600 })
      const { userId } = await openBreakGlassAccount(auth) // as a crash would leave it
      const v1 = await ctx.internalAdapter.createUser(
        {
          email: 'break-glass-20261022-a1b2c3@hub.slayzone.local',
          name: 'Break-glass (temporary)',
          emailVerified: true,
          role: 'user'
        },
        { method: 'admin' }
      )
      audit.length = 0
      const closed = await breakGlass.closeAtBoot(dataRoot)
      assertEq(closed.sort(), [userId, v1.id].sort(), 'both closed')
      assert(!existsSync(v1File), 'v1 file removed')
      const end = audit.find((l) => l.event === 'auth.break_glass.end')
      assertEq(
        end?.detail,
        { stage: 'boot', reason: 'boot', accounts: 2, legacyFile: true },
        'audited'
      )
      audit.length = 0
      assertEq(await breakGlass.closeAtBoot(dataRoot), [], 'nothing the second time')
      assertEq(audit.length, 0, 'and no line')
    })

    await test('nothing secret on disk: no token or verifier in any file the hub wrote', () => {
      const files: string[] = []
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name)
          if (entry.isDirectory()) walk(p)
          else if (entry.isFile()) files.push(p)
        }
      }
      walk(tmpDir)
      assert(
        files.some((f) => f.endsWith('hub-auth.sqlite')),
        'the auth DB is scanned'
      )
      for (const f of files) {
        const text = readFileSync(f).toString('latin1')
        for (const s of secrets) assert(!text.includes(s), `${f} holds a secret`)
      }
    })

    await test('alice, the real admin, was never touched', async () => {
      const row = (await listHubUsers(auth)).find((u) => u.id === alice.id)
      assert(row && row.role === 'admin' && row.disabledAt === null, 'alice unchanged')
    })
  } finally {
    setSecurityLogSink()
    mcpRest.dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await harness.cleanup()
    rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
  process.exit(0)
}

void main()
