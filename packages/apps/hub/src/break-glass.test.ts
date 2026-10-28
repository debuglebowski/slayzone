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
 * Native ABI (the app DB is better-sqlite3 built for Electron) → vitest under Electron's
 * node (packages/shared/test-utils/vitest.harness.config.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
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
import { createMcpRestApp } from '@slayzone/api'
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
if (!proxies.ok) throw new Error('trusted proxies parse')
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
if (!socketPath) throw new Error('socket path')
const secrets: string[] = []

afterAll(async () => {
  setSecurityLogSink()
  mcpRest.dispose()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await harness.cleanup()
  rmSync(tmpDir, { recursive: true, force: true })
})

test('login off: break-glass is off — no grant, no redemption, idle', async () => {
  const off = createBreakGlass({
    getAuth: () => auth,
    requireLogin: false,
    revokeUser: async () => undefined
  })
  expect(off.enabled(), 'disabled').toEqual(false)
  const g = await off.grant({ challenge: pair().challenge, by: OPERATOR })
  expect(g, 'grant unavailable').toMatchObject({ ok: false, code: 'unavailable' })
  const r = await off.redeem({ verifier: pair().verifier, ip: null })
  expect(r, 'redeem unavailable').toMatchObject({ ok: false, reason: 'unavailable' })
  expect(off.status(), 'idle').toEqual({ state: 'idle' })
})

test('the operator command refuses where no hub serves break-glass (login off, not running)', async () => {
  const empty = join(tmpDir, 'e')
  mkdirSync(empty)
  const { err, sink } = io()
  const code = await runBreakGlassCommand(['status', '--root', empty], sink)
  expect(code, 'exit 1').toEqual(1)
  expect(err.join('\n'), err.join('\n')).toContain('does not require login')
})

describe('with the admin socket open', () => {
  let adminSocket: Awaited<ReturnType<typeof startHubAdminSocket>> = null
  beforeAll(async () => {
    adminSocket = await startHubAdminSocket({ socketPath, breakGlass, log })
    expect(adminSocket, 'socket started').toBeTruthy()
  })
  afterAll(async () => {
    await adminSocket?.close()
  })

  test('the channel: 0600 socket in a 0700 directory', () => {
    expect(statSync(socketPath).mode & 0o777, 'socket 0600').toEqual(0o600)
    expect(statSync(join(dataRoot, 'run')).mode & 0o777, 'dir 0700').toEqual(0o700)
  })

  test('grant validation: a malformed challenge or TTL opens nothing', async () => {
    const { err, sink } = io()
    expect(
      await runBreakGlassCommand(['open', '--challenge', 'short', '--root', dataRoot], sink),
      'bad challenge refused'
    ).toEqual(1)
    expect(err.join('\n'), err.join('\n')).toContain('43-character')
    const ttl = await breakGlass.grant({
      challenge: pair().challenge,
      ttlMs: 3 * 60 * 60_000,
      by: OPERATOR
    })
    expect(ttl, 'ttl over 2h refused').toMatchObject({ ok: false, code: 'invalid' })
    expect(breakGlass.status(), 'still idle').toEqual({ state: 'idle' })
  })

  let session = ''
  const first = pair()
  secrets.push(first.verifier)
  test('open over the socket: a pending grant, audited with the operator, nothing secret printed', async () => {
    const { out, sink } = io()
    audit.length = 0
    const code = await runBreakGlassCommand(
      ['open', '--challenge', first.challenge, '--ttl', '30m', '--root', dataRoot],
      sink
    )
    expect(code, 'exit 0').toEqual(0)
    const status = breakGlass.status()
    expect(status.state, 'pending').toBe('pending')
    const ref = (status as Extract<typeof status, { state: 'pending' }>).ref
    expect(out.join('\n'), 'output names the grant').toContain(ref)
    expect(out.join('\n'), 'output holds no verifier').not.toContain(first.verifier)
    const grant = audit.find((l) => l.event === 'auth.break_glass.grant')
    expect(grant, 'grant line').toBeTruthy()
    expect(grant?.outcome, 'grant line').toBe('success')
    expect(grant?.level, 'grant line').toBe('warn')
    expect(grant?.detail.grantRef, 'grantRef').toEqual(ref)
    expect(typeof grant?.detail.osUser, 'osUser recorded').toBe('string')
    expect(grant?.detail.ttlSec, 'ttl').toEqual(1800)
    expect(JSON.stringify(audit), 'challenge not logged').not.toContain(first.challenge)
    const { out: st, sink: stSink } = io()
    expect(await runBreakGlassCommand(['status', '--root', dataRoot], stSink), 'status').toEqual(0)
    expect(st.join('\n'), st.join('\n')).toContain('waiting to be redeemed')
  })

  test('redeem: a wrong verifier is refused and leaves the grant; the right one opens an admin session', async () => {
    audit.length = 0
    const wrong = await redeemHttp(pair().verifier)
    expect(wrong.status, 'wrong verifier 403').toEqual(403)
    expect(wrong.body.code, 'one refusal code').toEqual('BREAK_GLASS_REFUSED')
    expect(breakGlass.status().state, 'grant kept').toEqual('pending')
    expect((await account())?.disabledAt ?? 'none', 'no account yet').toEqual('none')

    const ok = await redeemHttp(first.verifier)
    expect(ok.status, `redeemed: ${JSON.stringify(ok.body)}`).toEqual(200)
    session = ok.body.token
    secrets.push(session)
    expect(session, 'szbg_ token').toMatch(/^szbg_[A-Za-z0-9_-]{43}$/)
    expect(ok.body.email, 'as the break-glass account').toEqual(BREAK_GLASS_EMAIL)
    expect(ok.body.expiresAt, 'TTL from now').toEqual(new Date(now + 30 * 60_000).toISOString())
    const row = await account()
    expect(row, 'account open as admin').toBeTruthy()
    expect(row?.role, 'account open as admin').toBe('admin')
    expect(row?.disabledAt, 'account open as admin').toBeNull()
    expect(breakGlass.status().state, 'active').toEqual('active')
    const denied = audit.find(
      (l) => l.event === 'auth.break_glass.redeem' && l.outcome === 'denied'
    )
    expect(denied?.detail.reason, 'mismatch audited').toEqual('mismatch')
    expect(denied?.ip, 'client address (T-22)').toEqual('203.0.113.9')
    const redeemed = audit.find(
      (l) => l.event === 'auth.break_glass.redeem' && l.outcome === 'success'
    )
    expect(redeemed?.ip, 'redeem ip is the resolved client').toEqual('203.0.113.9')
    expect(redeemed?.actor, 'actor is the break-glass account').toEqual(row?.id)
    const all = `${JSON.stringify(audit)}\n${logs.join('\n')}`
    expect(all, 'no secret in any line').not.toContain(session)
    expect(all, 'no secret in any line').not.toContain(first.verifier)
  })

  test('works once: the same verifier again is refused; no new grant while it is open', async () => {
    audit.length = 0
    const again = await redeemHttp(first.verifier)
    expect(again.status, 'second use 403').toEqual(403)
    expect(
      audit.find((l) => l.event === 'auth.break_glass.redeem')?.detail.reason,
      'audited as used'
    ).toEqual('used')
    const { err, sink } = io()
    const code = await runBreakGlassCommand(
      ['open', '--challenge', pair().challenge, '--root', dataRoot],
      sink
    )
    expect(code, 'second grant refused').toEqual(1)
    expect(err.join('\n'), err.join('\n')).toContain('end it first')
  })

  test('the session disables a user and revokes a computer, attributed to it', async () => {
    const id = (await account())!.id
    audit.length = 0
    const disabled = await call('PATCH', '/api/hub/users', {
      token: session,
      body: { email: 'bob@example.com', disabled: true }
    })
    expect(disabled.status, `disable: ${JSON.stringify(disabled.body)}`).toEqual(200)
    expect(
      (await listHubUsers(auth)).find((u) => u.id === bob.id)?.disabledAt,
      'bob disabled'
    ).toBeTruthy()
    const listed = await call('GET', '/api/hub/users', { token: session })
    expect(listed.status, 'list users').toEqual(200)
    const revoked = await call('PATCH', '/api/hub/computers', {
      token: session,
      body: { id: 'c-laptop', revoked: true }
    })
    expect(revoked.status, `revoke: ${JSON.stringify(revoked.body)}`).toEqual(200)
    expect((await getComputer(db, 'c-laptop'))?.revoked_at, 'computer revoked').toBeTruthy()
    expect(dropped, 'its connection dropped').toContain('c-laptop')
    const computers = await call('GET', '/api/computers', { token: session })
    expect(computers.status, 'list computers').toEqual(200)
    const disable = audit.find((l) => l.event === 'user.disable' && l.outcome === 'success')
    expect(disable?.actor, 'user.disable by the break-glass account').toEqual(id)
    const revoke = audit.find((l) => l.event === 'computer.revoke')
    expect(revoke?.actor, 'computer.revoke by the break-glass account').toEqual(id)
    expect(
      audit.filter((l) => l.event === 'auth.break_glass.use').length,
      'one use line per request'
    ).toEqual(4)
  })

  test('…and reaches nothing else: content, /mcp, join tokens, accounts, its role, /trpc, grants', async () => {
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
      expect(r.status, `${method} ${path}`).toEqual(403)
    }
    expect(
      audit.filter((l) => l.event === 'authz.denied' && l.detail.reason === 'break_glass').length,
      'each refusal audited break_glass'
    ).toEqual(refused.length)
    const ownRole = await call('PATCH', '/api/hub/users', {
      token: session,
      body: { email: BREAK_GLASS_EMAIL, role: 'user' }
    })
    expect(ownRole.status, 'its own role: refused (Entra hub: roles are Entra’s)').toEqual(409)
    const ownDisable = await call('PATCH', '/api/hub/users', {
      token: session,
      body: { email: BREAK_GLASS_EMAIL, disabled: true }
    })
    expect(ownDisable.status, 'itself: protected').toEqual(409)
    expect(String(ownDisable.body.error), String(ownDisable.body.error)).toContain('break-glass')
    expect(
      await resolveConnectionPrincipal({
        hubAuthRequired: true,
        hubAuth: auth,
        db,
        token: session
      }),
      '/trpc never accepts it'
    ).toEqual(null)
    expect(breakGlass.status().state, 'still the one session').toEqual('active')
  })

  test('TTL: refused at expiry even before the timer runs; the timer closes the account', async () => {
    const timer = timers.at(-1)
    expect(timer, 'a 30 min timer').toBeTruthy()
    expect(timer?.cancelled, 'a 30 min timer').toBe(false)
    expect(timer?.ms, 'a 30 min timer').toBe(30 * 60_000)
    now += 30 * 60_000
    expect(await breakGlass.resolve(session), 'refused at expiry').toEqual(null)
    const after = await call('GET', '/api/hub/users', { token: session })
    expect(after.status, 'expired token 401').toEqual(401)
    timer?.fn()
    for (let i = 0; i < 50 && (await account())?.disabledAt === null; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    const row = await account()
    expect(row?.disabledAt, 'closed: disabled user').toBeTruthy()
    expect(row?.role, 'closed: disabled user').toBe('user')
    expect(breakGlass.status(), 'idle').toEqual({ state: 'idle' })
    const end = audit.filter((l) => l.event === 'auth.break_glass.end').at(-1)
    expect(end?.detail.reason, 'end expired').toEqual('expired')
    expect(
      (await listHubUsers(auth)).find((u) => u.id === bob.id)?.disabledAt,
      'bob stays disabled'
    ).toBeTruthy()
  })

  test('the end command ends a session: account closed, token refused', async () => {
    const p = pair()
    expect(
      (await breakGlass.grant({ challenge: p.challenge, by: OPERATOR })).ok,
      'grant'
    ).toBeTruthy()
    const r = await redeemHttp(p.verifier)
    expect(r.status, 'redeemed').toEqual(200)
    const { out, sink } = io()
    expect(await runBreakGlassCommand(['end', '--root', dataRoot], sink), 'end ok').toEqual(0)
    expect(out.join('\n'), out.join('\n')).toContain('session ended')
    expect(await breakGlass.resolve(r.body.token), 'token refused').toEqual(null)
    expect((await call('GET', '/api/hub/users', { token: r.body.token })).status, '401').toEqual(
      401
    )
    expect((await account())?.disabledAt, 'account closed').toBeTruthy()
    const end = audit.filter((l) => l.event === 'auth.break_glass.end').at(-1)
    expect(end?.detail.reason, 'end reason').toEqual('ended')
    expect(typeof end?.detail.osUser, 'who ended it').toBe('string')
    // Once means once: after the session, its verifier redeems nothing either.
    expect((await redeemHttp(p.verifier)).status, 'the old verifier is dead').toEqual(403)
    expect(breakGlass.status(), 'nothing reopened').toEqual({ state: 'idle' })
  })

  test('the session can end itself (DELETE); another bearer cannot', async () => {
    const p = pair()
    expect(
      (await breakGlass.grant({ challenge: p.challenge, by: OPERATOR })).ok,
      'grant'
    ).toBeTruthy()
    const r = await redeemHttp(p.verifier)
    expect((await call('DELETE', BREAK_GLASS_PATH, { token: 'szbg_nope' })).status, '401').toEqual(
      401
    )
    expect(breakGlass.status().state, 'still open').toEqual('active')
    const del = await call('DELETE', BREAK_GLASS_PATH, { token: r.body.token })
    expect(del.status, 'ended').toEqual(200)
    expect(breakGlass.status(), 'idle').toEqual({ state: 'idle' })
    expect((await account())?.disabledAt, 'account closed').toBeTruthy()
  })

  test('a grant nobody redeems expires after 10 minutes', async () => {
    const p = pair()
    expect(
      (await breakGlass.grant({ challenge: p.challenge, by: OPERATOR })).ok,
      'grant'
    ).toBeTruthy()
    now += BREAK_GLASS_GRANT_TTL_MS
    expect(breakGlass.status(), 'expired grant is not shown').toEqual({ state: 'idle' })
    audit.length = 0
    expect((await redeemHttp(p.verifier)).status, 'expired refused').toEqual(403)
    expect(
      audit.find((l) => l.event === 'auth.break_glass.redeem')?.detail.reason,
      'audited as expired'
    ).toEqual('expired')
  })

  test('racing redemptions consume a grant once', async () => {
    const p = pair()
    expect(
      (await breakGlass.grant({ challenge: p.challenge, by: OPERATOR })).ok,
      'grant'
    ).toBeTruthy()
    const results = await Promise.all([redeemHttp(p.verifier), redeemHttp(p.verifier)])
    expect(results.map((r) => r.status).sort(), 'one wins').toEqual([200, 403])
    await breakGlass.end('ended')
  })

  test('stop closes an open session (server.ts calls end at stop)', async () => {
    const p = pair()
    expect(
      (await breakGlass.grant({ challenge: p.challenge, by: OPERATOR })).ok,
      'grant'
    ).toBeTruthy()
    expect((await redeemHttp(p.verifier)).status, 'redeemed').toEqual(200)
    const ended = await breakGlass.end('stop')
    expect(ended, 'session ended').toEqual({ grant: false, session: true })
    expect((await account())?.disabledAt, 'account closed').toBeTruthy()
  })
})

test('the socket is gone after close, and the command says so', async () => {
  expect(existsSync(socketPath), 'socket removed').toBeFalsy()
  const { err, sink } = io()
  expect(await runBreakGlassCommand(['end', '--root', dataRoot], sink), 'exit 1').toEqual(1)
  expect(err.join('\n'), err.join('\n')).toContain('No hub with break-glass')
})

test('boot: v1’s file removed, leftover accounts (v2 and v1) closed, audited, idempotent', async () => {
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
  expect(closed.sort(), 'both closed').toEqual([userId, v1.id].sort())
  expect(existsSync(v1File), 'v1 file removed').toBeFalsy()
  const end = audit.find((l) => l.event === 'auth.break_glass.end')
  expect(end?.detail, 'audited').toEqual({
    stage: 'boot',
    reason: 'boot',
    accounts: 2,
    legacyFile: true
  })
  audit.length = 0
  expect(await breakGlass.closeAtBoot(dataRoot), 'nothing the second time').toEqual([])
  expect(audit.length, 'and no line').toEqual(0)
})

test('nothing secret on disk: no token or verifier in any file the hub wrote', () => {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) files.push(p)
    }
  }
  walk(tmpDir)
  expect(
    files.some((f) => f.endsWith('hub-auth.sqlite')),
    'the auth DB is scanned'
  ).toBeTruthy()
  for (const f of files) {
    const text = readFileSync(f).toString('latin1')
    for (const s of secrets) expect(text, `${f} holds a secret`).not.toContain(s)
  }
})

test('alice, the real admin, was never touched', async () => {
  const row = (await listHubUsers(auth)).find((u) => u.id === alice.id)
  expect(row, 'alice unchanged').toBeTruthy()
  expect(row?.role, 'alice unchanged').toBe('admin')
  expect(row?.disabledAt, 'alice unchanged').toBeNull()
})
