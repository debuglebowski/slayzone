/**
 * The real client IP behind a trusted front end (T-22), against the REAL built hub.
 *
 * Every hub here listens on 127.0.0.1, so every test request's TCP peer is
 * 127.0.0.1. That is how the two cases are made without faking a socket address:
 *
 *   - THROUGH A TRUSTED FRONT END: a hub with `SLAYZONE_HUB_TRUSTED_PROXIES=127.0.0.1`.
 *     This test then IS the front end: it sends `X-Forwarded-For: <client>:<port>`
 *     exactly as an Application Gateway v2 appends it.
 *   - FROM AN UNTRUSTED PEER: a hub whose list is `10.93.4.0/24` (a gateway subnet the
 *     test is not in). The same headers now come from a client dialling the hub
 *     directly, and must change nothing.
 *
 * Proved, per case: the audit `ip` of a REST refusal, a `/trpc` upgrade (origin
 * refusal) and a `/trpc` call on it (auth gate), a `/computers` upgrade (enroll
 * refusal) and a better-auth sign-in; the `ipAddress` better-auth stores on the
 * session; and better-auth's rate-limit key — its limiter is on for every reachable
 * hub whatever NODE_ENV says (T-26, hub-auth `rate-limit.ts`: 10 sign-ins a minute per
 * key; the front-end hub runs with NODE_ENV=production as the hosted hub does, the
 * direct one without): through the front end two clients get separate buckets, while
 * a direct client rotating `X-Forwarded-For` (and the hub's own client-IP header)
 * stays in ONE bucket, its peer's. Then: a reachable hub with
 * no list warns once at boot and records the peer; the default hub (loopback, login
 * off, no list — the desktop app's shape) does not warn and records the peer; a
 * malformed list refuses boot (B15).
 *
 * Isolation: throwaway SLAYZONE_ROOT per hub, every inherited SLAYZONE_/ELECTRON_ var
 * scrubbed, OS-assigned ports. Native ABI: the hub bundle (better-sqlite3) runs under
 * `ELECTRON_RUN_AS_NODE=1 electron`, and so does this test. The bundle is (re)built
 * on demand.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/trusted-proxy.test.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, assert, beforeAll, describe, expect, test } from 'vitest'
import WebSocket from 'ws'
import { AUTH_RATE_LIMIT_RULES } from '@slayzone/hub-auth/server'
import { deriveBootstrapOwnerPassword } from '@slayzone/platform/hub-auth-secret'
import { BOOTSTRAP_OWNER_EMAIL } from '@slayzone/platform/hub-owner-file'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..') // packages/apps/hub
const PACKAGES = join(HUB_DIR, '..', '..') // packages/
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const ELECTRON_BIN = require('electron') as unknown as string

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

/** (Re)build the hub bundle when it is missing or older than the sources this test
 *  exercises — the resolver and better-auth's config live outside the app. */
function ensureBuilt(): void {
  const srcDirs = [
    join(HUB_DIR, 'src'),
    join(PACKAGES, 'shared', 'platform', 'src'),
    join(PACKAGES, 'shared', 'transport', 'src', 'server'),
    join(PACKAGES, 'domains', 'hub-auth', 'src'),
    join(PACKAGES, 'domains', 'computer-transport', 'src')
  ]
  let needs = !existsSync(HUB_BIN)
  if (!needs) {
    const built = statSync(HUB_BIN).mtimeMs
    needs = srcDirs.some((d) => newestMtime(d) > built)
  }
  if (!needs) return
  console.log('  … building hub bundle (bin missing or stale)')
  execFileSync('node', ['build.mjs'], { cwd: HUB_DIR, stdio: 'inherit' })
  if (!existsSync(HUB_BIN)) throw new Error(`hub build did not produce ${HUB_BIN}`)
}

/** Inherited env minus every SLAYZONE_/ELECTRON_ key (and NODE_ENV, set per hub). */
function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue
    if (/^(SLAYZONE_|ELECTRON_)/.test(k) || k === 'NODE_ENV' || k === 'PLAYWRIGHT') continue
    out[k] = v
  }
  return out
}

interface Hub {
  proc: ChildProcess
  logs: string[]
  stderr: string[]
  exit: Promise<number | null>
  port: number
  dataRoot: string
  stop: () => Promise<void>
}

const roots: string[] = []

function spawnHub(env: Record<string, string>): Omit<Hub, 'port' | 'dataRoot'> {
  const root = mkdtempSync(join(tmpdir(), 'slz-trusted-proxy-'))
  roots.push(root)
  const logs: string[] = []
  const stderr: string[] = []
  // stdin is a held-open PIPE (a hub may treat stdin EOF as "my parent died").
  const proc = spawn(ELECTRON_BIN, [HUB_BIN], {
    cwd: root,
    env: { ...scrubbedEnv(), ...env, SLAYZONE_ROOT: root, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const cap =
    (into: string[][]) =>
    (b: Buffer): void => {
      for (const line of b.toString().split('\n')) {
        if (line.trim()) for (const list of into) list.push(line)
      }
    }
  proc.stdout?.on('data', cap([logs]))
  proc.stderr?.on('data', cap([logs, stderr]))
  const exit = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)))
  return {
    proc,
    logs,
    stderr,
    exit,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
        const t = setTimeout(() => proc.kill('SIGKILL'), 3_000)
        proc.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
        proc.kill('SIGTERM')
      })
  }
}

async function poll<T>(fn: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v != null) return v
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function bootHub(env: Record<string, string>): Promise<Hub> {
  const hub = spawnHub(env)
  const line = await poll(
    async () => hub.logs.find((l) => l.includes('listening on http://')) ?? null,
    40_000,
    `hub listening line (logs:\n${hub.logs.join('\n')})`
  )
  const m = line.match(/http:\/\/127\.0\.0\.1:(\d+) \(data=(.+) db=/)
  assert(m, `listening line parseable: ${line}`)
  return { ...hub, port: Number(m[1]), dataRoot: m[2]! }
}

const SECRET = randomBytes(32).toString('hex')

/** A hub other machines reach through a front end: login on, public address set. */
const REACHABLE = {
  SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
  SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.test',
  SLAYZONE_HUB_REQUIRE_LOGIN: '1',
  SLAYZONE_HUB_AUTH_SECRET: SECRET
}

// --- requests -------------------------------------------------------------

interface HttpResult {
  status: number
  body: string
}

/** One HTTP request. A header given as an array goes out as that many header lines. */
function http(
  port: number,
  method: string,
  path: string,
  headers: OutgoingHttpHeaders = {},
  body?: unknown
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...headers,
          // A declared length, like any real client: the hub refuses a chunked auth
          // body (`guardAuthRequestBody`).
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {})
        }
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => {
          data += c
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      }
    )
    req.on('error', reject)
    req.setTimeout(10_000, () => req.destroy(new Error(`${method} ${path} timed out`)))
    if (payload) req.write(payload)
    req.end()
  })
}

/** Open a websocket; resolves when open, or with the refusal status (0 when the hub
 *  reset the socket before its status line was read — it writes 403 and destroys). */
function openWs(
  port: number,
  path: string,
  headers: Record<string, string>
): Promise<{ ws: WebSocket } | { refused: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
    ws.once('open', () => resolve({ ws }))
    ws.once('unexpected-response', (_req, res) => {
      resolve({ refused: res.statusCode ?? 0 })
      ws.terminate()
    })
    ws.once('error', () => resolve({ refused: 0 }))
  })
}

// --- audit lines ------------------------------------------------------------

interface AuditLine {
  event: string
  outcome: string
  ip: string | null
  route: string | null
  targetId: string | null
  detail: Record<string, unknown>
}

function auditSince(hub: Hub, mark: number): AuditLine[] {
  return hub.logs
    .slice(mark)
    .filter((l) => l.startsWith('{"type":"security"'))
    .map((l) => JSON.parse(l) as AuditLine)
}

/** Wait for the first audit line after `mark` matching `pred`. */
function waitAudit(
  hub: Hub,
  mark: number,
  pred: (a: AuditLine) => boolean,
  label: string
): Promise<AuditLine> {
  return poll(
    async () => auditSince(hub, mark).find(pred) ?? null,
    10_000,
    `${label} (audit lines since mark:\n${auditSince(hub, mark)
      .map((a) => JSON.stringify(a))
      .join('\n')})`
  )
}

/** Every hub here is reachable, so its owner has no file: the password derives from the secret (T-11). */
function owner(_hub: Hub): { email: string; password: string } {
  return { email: BOOTSTRAP_OWNER_EMAIL, password: deriveBootstrapOwnerPassword(SECRET) }
}

// --- the probes, run against one hub -----------------------------------------

/** REST refusal (no bearer) → the audit ip. */
async function restAuditIp(hub: Hub, headers: OutgoingHttpHeaders): Promise<string | null> {
  const mark = hub.logs.length
  const res = await http(hub.port, 'GET', '/api/tasks', headers)
  expect(res.status, `GET /api/tasks without a bearer is 401, got ${res.status}`).toBe(401)
  const line = await waitAudit(
    hub,
    mark,
    (a) => a.event === 'authz.denied' && a.route === 'GET /api/tasks',
    'REST authz.denied'
  )
  return line.ip
}

/** `/trpc` upgrade from a foreign origin → refused, audited with the ip. */
async function trpcOriginAuditIp(hub: Hub, xff: string): Promise<string | null> {
  const mark = hub.logs.length
  const r = await openWs(hub.port, '/trpc', {
    origin: 'https://evil.example',
    'x-forwarded-for': xff
  })
  assert(
    'refused' in r && (r.refused === 403 || r.refused === 0),
    `foreign-origin upgrade refused: ${JSON.stringify(r)}`
  )
  const line = await waitAudit(
    hub,
    mark,
    (a) => a.event === 'authz.denied' && a.detail.reason === 'origin',
    '/trpc origin authz.denied'
  )
  return line.ip
}

/** `/trpc` upgrade accepted, then a gated call with no token → audited with the ip. */
async function trpcCallAuditIp(hub: Hub, xff: string): Promise<string | null> {
  const mark = hub.logs.length
  const r = await openWs(hub.port, '/trpc', { 'x-forwarded-for': xff })
  assert('ws' in r, `upgrade accepted: ${JSON.stringify(r)}`)
  try {
    const reply = new Promise<string>((resolve) =>
      r.ws.once('message', (data) => resolve(data.toString()))
    )
    // tRPC v11 over ws; the input is superjson-encoded (`{ json }`).
    r.ws.send(
      JSON.stringify({
        id: 1,
        method: 'query',
        params: { path: 'projects.list', input: { json: null } }
      })
    )
    const msg = await reply
    expect(msg, `gated call refused without a token: ${msg}`).toContain('UNAUTHORIZED')
  } finally {
    r.ws.close()
  }
  const line = await waitAudit(
    hub,
    mark,
    (a) => a.event === 'authz.denied' && a.targetId === 'projects.list',
    '/trpc authz.denied'
  )
  return line.ip
}

/** `/computers` upgrade, malformed enroll → `computer.enroll` failure with the ip. */
async function computerAuditIp(hub: Hub, xff: string): Promise<string | null> {
  const mark = hub.logs.length
  const r = await openWs(hub.port, '/computers', { 'x-forwarded-for': xff })
  assert('ws' in r, `computer upgrade accepted: ${JSON.stringify(r)}`)
  try {
    r.ws.send(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'enroll', params: {} })}\n`)
    const line = await waitAudit(
      hub,
      mark,
      (a) => a.event === 'computer.enroll' && a.outcome === 'failure',
      'computer.enroll failure'
    )
    return line.ip
  } finally {
    r.ws.terminate()
  }
}

/** Sign in as the owner; returns the token and the ip of the `auth.signin` line. */
async function signIn(
  hub: Hub,
  headers: OutgoingHttpHeaders
): Promise<{ token: string; auditIp: string | null }> {
  const mark = hub.logs.length
  const res = await http(hub.port, 'POST', '/api/auth/sign-in/email', headers, owner(hub))
  expect(res.status, `owner sign-in is 200, got ${res.status}: ${res.body}`).toBe(200)
  const token = (JSON.parse(res.body) as { token?: string }).token
  expect(typeof token, `sign-in returned a token: ${res.body}`).toBe('string')
  assert(token, `sign-in returned a token: ${res.body}`)
  const line = await waitAudit(
    hub,
    mark,
    (a) => a.event === 'auth.signin' && a.outcome === 'success',
    'auth.signin success'
  )
  return { token, auditIp: line.ip }
}

/** Every session of `token`'s user, as better-auth lists them. */
async function sessions(
  hub: Hub,
  token: string
): Promise<Array<{ token?: string; ipAddress?: string }>> {
  const res = await http(hub.port, 'GET', '/api/auth/list-sessions', {
    authorization: `Bearer ${token}`
  })
  expect(res.status, `list-sessions is 200, got ${res.status}: ${res.body}`).toBe(200)
  return JSON.parse(res.body) as Array<{ token?: string; ipAddress?: string }>
}

/** The `ipAddress` better-auth stored on the session `token` belongs to. */
async function sessionIp(hub: Hub, token: string): Promise<string> {
  const mine = (await sessions(hub, token)).find((s) => s.token === token)
  assert(mine, `the new session is listed`)
  return mine.ipAddress ?? ''
}

/** A wrong-password sign-in; returns the status (401, or 429 once rate-limited). */
async function badSignIn(hub: Hub, headers: OutgoingHttpHeaders): Promise<number> {
  const res = await http(hub.port, 'POST', '/api/auth/sign-in/email', headers, {
    email: owner(hub).email,
    password: 'not-the-password'
  })
  return res.status
}

const CLIENT_IP_HEADER = 'x-slayzone-client-ip'

/** Sign-ins one client address may make in a window (better-auth, T-26). */
const SIGN_IN_MAX = AUTH_RATE_LIMIT_RULES['/sign-in/*']!.max

beforeAll(() => ensureBuilt())

const hubs: Hub[] = []
afterAll(async () => {
  await Promise.all(hubs.map((h) => h.stop()))
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

// --- through a trusted front end ------------------------------------------
describe('through a trusted front end', () => {
  let front: Hub
  beforeAll(async () => {
    front = await bootHub({
      ...REACHABLE,
      SLAYZONE_HUB_TRUSTED_PROXIES: '127.0.0.1',
      NODE_ENV: 'production'
    })
    hubs.push(front)
  })

  test('front end trusted: a REST request is audited with the forwarded client', async () => {
    const ip = await restAuditIp(front, { 'x-forwarded-for': '203.0.113.7:51234' })
    expect(ip, `ip = client, got ${ip}`).toBe('203.0.113.7')
  })

  test('front end trusted: what the client put left of the appended entry is ignored', async () => {
    const chain = await restAuditIp(front, { 'x-forwarded-for': '6.6.6.6, 203.0.113.8:1' })
    expect(chain, `rightmost untrusted, got ${chain}`).toBe('203.0.113.8')
    const lines = await restAuditIp(front, { 'x-forwarded-for': ['6.6.6.6', '203.0.113.9:2'] })
    expect(lines, `two header lines are one list, got ${lines}`).toBe('203.0.113.9')
    const v6 = await restAuditIp(front, { 'x-forwarded-for': '[2001:db8:cafe::7]:443' })
    expect(v6, `[v6]:port, got ${v6}`).toBe('2001:db8:cafe::7')
  })

  test('front end trusted: a malformed entry falls back to the front end, never to it', async () => {
    const ip = await restAuditIp(front, { 'x-forwarded-for': '203.0.113.7, not-an-ip' })
    expect(ip, `the peer, got ${ip}`).toBe('127.0.0.1')
  })

  test('front end trusted: /trpc upgrades — origin refusal and gated call — log the client', async () => {
    const refused = await trpcOriginAuditIp(front, '203.0.113.41:1')
    expect(refused, `origin refusal ip, got ${refused}`).toBe('203.0.113.41')
    const called = await trpcCallAuditIp(front, '203.0.113.40:1000')
    expect(called, `auth gate ip, got ${called}`).toBe('203.0.113.40')
  })

  test('front end trusted: a /computers upgrade logs the client', async () => {
    const ip = await computerAuditIp(front, '203.0.113.42:7')
    expect(ip, `computer.enroll ip, got ${ip}`).toBe('203.0.113.42')
  })

  test('front end trusted: better-auth stores and audits the client, not a supplied header', async () => {
    const { token, auditIp } = await signIn(front, {
      'x-forwarded-for': '6.6.6.6, 203.0.113.20:4321',
      [CLIENT_IP_HEADER]: '6.6.6.6'
    })
    expect(auditIp, `auth.signin ip, got ${auditIp}`).toBe('203.0.113.20')
    const stored = await sessionIp(front, token)
    expect(stored, `session.ipAddress, got '${stored}'`).toBe('203.0.113.20')
    // The scoped browser sign-in calls better-auth in-process: same client address.
    const web = await http(
      front.port,
      'POST',
      '/api/auth/web-login',
      { 'x-forwarded-for': '203.0.113.21:9', [CLIENT_IP_HEADER]: '6.6.6.6' },
      owner(front)
    )
    expect(web.status, `web-login is 200, got ${web.status}: ${web.body}`).toBe(200)
    const ips = (await sessions(front, token)).map((s) => s.ipAddress)
    expect(ips, `web-login session ipAddress: ${ips}`).toContain('203.0.113.21')
    expect(ips, `no supplied value stored: ${ips}`).not.toContain('6.6.6.6')
  })

  test('front end trusted: better-auth rate-limits per client, not per front end', async () => {
    const a = { 'x-forwarded-for': '203.0.113.30:1' }
    const statuses: number[] = []
    for (let i = 0; i <= SIGN_IN_MAX; i++) statuses.push(await badSignIn(front, a))
    // client A: SIGN_IN_MAX tries, then 429
    expect(statuses).toEqual([...Array(SIGN_IN_MAX).fill(401), 429])
    const b = await badSignIn(front, { 'x-forwarded-for': '203.0.113.31:1' })
    expect(b, `client B has its own bucket, got ${b}`).toBe(401)
    // A cannot borrow B's bucket by naming B itself: the gateway appends A.
    const spoof = await badSignIn(front, {
      'x-forwarded-for': '203.0.113.31, 203.0.113.30:2',
      [CLIENT_IP_HEADER]: '203.0.113.31'
    })
    expect(spoof, `A stays A, got ${spoof}`).toBe(429)
  })
})

// --- the same headers from a peer the hub does not trust ------------------
// NODE_ENV=development, not unset (the hub defaults an unset one to production): the
// limiter must not need production (T-26).
describe('the same headers from a peer the hub does not trust', () => {
  let direct: Hub
  beforeAll(async () => {
    direct = await bootHub({
      ...REACHABLE,
      SLAYZONE_HUB_TRUSTED_PROXIES: '10.93.4.0/24',
      NODE_ENV: 'development'
    })
    hubs.push(direct)
  })

  test('untrusted peer: X-Forwarded-For is ignored on REST, /trpc and /computers', async () => {
    const rest = await restAuditIp(direct, { 'x-forwarded-for': '203.0.113.7:51234' })
    expect(rest, `REST ip = peer, got ${rest}`).toBe('127.0.0.1')
    const origin = await trpcOriginAuditIp(direct, '203.0.113.41:1')
    expect(origin, `/trpc origin ip = peer, got ${origin}`).toBe('127.0.0.1')
    const call = await trpcCallAuditIp(direct, '203.0.113.40:1')
    expect(call, `/trpc call ip = peer, got ${call}`).toBe('127.0.0.1')
    const computer = await computerAuditIp(direct, '203.0.113.42:7')
    expect(computer, `/computers ip = peer, got ${computer}`).toBe('127.0.0.1')
  })

  test('untrusted peer: a direct client cannot pick the IP better-auth stores or limits on', async () => {
    // One successful sign-in (counts toward the sign-in bucket)…
    const { token, auditIp } = await signIn(direct, {
      'x-forwarded-for': '203.0.113.20',
      [CLIENT_IP_HEADER]: '203.0.113.20'
    })
    expect(auditIp, `auth.signin ip = peer, got ${auditIp}`).toBe('127.0.0.1')
    const stored = await sessionIp(direct, token)
    expect(stored, `session.ipAddress = peer, got '${stored}'`).toBe('127.0.0.1')
    // …then a fresh spoofed address on every try. Before T-22 better-auth keyed on
    // X-Forwarded-For, so each try had a bucket of its own and the limit never hit.
    const statuses: number[] = []
    for (let i = 0; i < SIGN_IN_MAX; i++) {
      const fake = `198.51.100.${10 + i}`
      statuses.push(await badSignIn(direct, { 'x-forwarded-for': fake, [CLIENT_IP_HEADER]: fake }))
    }
    // one bucket, the peer's
    expect(statuses).toEqual([...Array(SIGN_IN_MAX - 1).fill(401), 429])
  })
})

// --- no list: the peer, and a warning when a front end is implied -----------
describe('a reachable hub with no list', () => {
  let unlisted: Hub
  beforeAll(async () => {
    unlisted = await bootHub(REACHABLE)
    hubs.push(unlisted)
  })

  test('reachable hub, empty list: one boot warning, and the peer is recorded', async () => {
    const warnings = unlisted.stderr.filter((l) => l.includes('SLAYZONE_HUB_TRUSTED_PROXIES'))
    expect(warnings, `one warning on stderr, got:\n${unlisted.stderr.join('\n')}`).toHaveLength(1)
    expect(warnings[0]!, `names the public address: ${warnings[0]}`).toContain('hub.example.test')
    const ip = await restAuditIp(unlisted, { 'x-forwarded-for': '203.0.113.7:51234' })
    expect(ip, `ip = peer, got ${ip}`).toBe('127.0.0.1')
  })
})

describe('the default hub', () => {
  let desktop: Hub
  beforeAll(async () => {
    desktop = await bootHub({ SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0' })
    hubs.push(desktop)
  })

  test('default hub (loopback, login off, no list): no warning, the peer as before', async () => {
    const warnings = desktop.logs.filter((l) => l.includes('SLAYZONE_HUB_TRUSTED_PROXIES'))
    expect(warnings, `no warning:\n${warnings.join('\n')}`).toHaveLength(0)
    const ip = await trpcOriginAuditIp(desktop, '203.0.113.41:1')
    expect(ip, `ip = peer, got ${ip}`).toBe('127.0.0.1')
  })
})

test('B15: a malformed list refuses boot through the bin, naming the variable', async () => {
  const hub = spawnHub({ ...REACHABLE, SLAYZONE_HUB_TRUSTED_PROXIES: '10.93.4.0/24, appgw' })
  try {
    const code = await Promise.race([
      hub.exit,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 40_000))
    ])
    expect(code, `refused, exit ${String(code)}`).not.toBe('timeout')
    expect(code, `refused, exit ${String(code)}`).not.toBe(0)
    const out = hub.logs.join('\n')
    expect(out, out).toContain('SLAYZONE_HUB_TRUSTED_PROXIES')
    expect(out, out).toContain("'appgw'")
    const audit = hub.logs.filter((l) => l.startsWith('{"type":"security"'))
    expect(audit, `hub.boot B15:\n${out}`).toHaveLength(1)
    expect(audit[0]!, `hub.boot B15:\n${out}`).toContain('"rule":"B15"')
  } finally {
    await hub.stop()
  }
})
