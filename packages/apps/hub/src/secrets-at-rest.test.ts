/**
 * T-11 through the REAL built hub (dist/bin.cjs): a hub other machines can reach (B13)
 * generates no secret to disk and logs none.
 *
 * Each hub boots with KNOWN secret values, is driven through the paths that touch a
 * credential (owner sign-in, a failed sign-in, a join token, a computer enrolling, an
 * account created, break-glass v2, Entra sign-in errors, boot refusals), stops, and then:
 *   - nothing under `<ROOT>/logs`, stdout or stderr holds any of those values, nor the
 *     auth secret's hex / base64 / base64url forms;
 *   - no file under `<ROOT>` (the databases and their WAL included) holds the auth
 *     secret in any form, the derived owner password, a generated password, a join
 *     token or a computer API key — only hashes and ciphertext;
 *   - there is no `hub.state.json`, `hub.owner.json` or `hub.break-glass.json`: break-glass
 *     v2 keeps its grant and session in memory, so its verifier and session token are on
 *     no disk and in no log either (v1's file, the former exception, is gone).
 * Plus the upgrade (compat): a hub that generated its secret while loopback-only, then
 * published with that secret in env, boots, leaves its old files untouched (and names
 * them), and keeps every session and enrolled computer; a different secret is B17.
 *
 * Accepted at rest and not checked here: session tokens in the auth database, computer
 * API-key hashes, no database encryption (T-48).
 *
 * Native ABI: better-sqlite3 needs Electron's node, so this runs under
 * `ELECTRON_RUN_AS_NODE=1 electron`.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/secrets-at-rest.test.ts
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, assert, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { COMPUTER_PROTOCOL_VERSION } from '@slayzone/computer-transport/shared'
import { deriveBootstrapOwnerPassword } from '@slayzone/platform/hub-auth-secret'
import { BOOTSTRAP_OWNER_EMAIL } from '@slayzone/platform/hub-owner-file'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..')
const PACKAGES = join(HUB_DIR, '..', '..')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const ELECTRON_BIN = require('electron') as unknown as string

// --- the built hub -------------------------------------------------------------

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

function ensureBuilt(): void {
  const srcDirs = [
    join(HUB_DIR, 'src'),
    join(PACKAGES, 'shared', 'platform', 'src'),
    join(PACKAGES, 'apps', 'api', 'src'),
    join(PACKAGES, 'domains', 'hub-auth', 'src'),
    join(PACKAGES, 'domains', 'computer-transport', 'src')
  ]
  const built = existsSync(HUB_BIN) ? statSync(HUB_BIN).mtimeMs : 0
  if (built && !srcDirs.some((d) => newestMtime(d) > built)) return
  console.log('  … building hub bundle (bin missing or stale)')
  execFileSync('node', ['build.mjs'], { cwd: HUB_DIR, stdio: 'inherit' })
  if (!existsSync(HUB_BIN)) throw new Error(`hub build did not produce ${HUB_BIN}`)
}

function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue
    if (/^(SLAYZONE_|ELECTRON_|BETTER_AUTH_)/.test(k) || k === 'PLAYWRIGHT') continue
    out[k] = v
  }
  return out
}

interface Hub {
  logs: string[]
  exit: Promise<number | null>
  stop: () => Promise<void>
}

function spawnHub(root: string, env: Record<string, string>): Hub {
  const logs: string[] = []
  const proc: ChildProcess = spawn(ELECTRON_BIN, [HUB_BIN], {
    cwd: root,
    env: { ...scrubbedEnv(), ...env, SLAYZONE_ROOT: root, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const cap = (b: Buffer): void => {
    for (const line of b.toString().split('\n')) if (line.trim()) logs.push(line)
  }
  proc.stdout?.on('data', cap)
  proc.stderr?.on('data', cap)
  const exit = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)))
  return {
    logs,
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

/** Run the built bin with `args` (an operator command, not a hub): exit code + output. */
function runBin(args: string[]): { code: number | null; out: string } {
  const r = spawnSync(ELECTRON_BIN, [HUB_BIN, ...args], {
    env: { ...scrubbedEnv(), ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 30_000
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

async function poll<T>(fn: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v != null) return v
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function bootAndGetPort(hub: Hub): Promise<number> {
  const line = await poll(
    async () => hub.logs.find((l) => l.includes('listening on http://')) ?? null,
    30_000,
    `hub listening line (logs:\n${hub.logs.join('\n')})`
  )
  const port = Number(line.match(/http:\/\/[^:]+:(\d+)/)?.[1])
  await poll(
    async () => ((await fetch(`http://127.0.0.1:${port}/health`)).ok ? true : null),
    15_000,
    'hub /health ok'
  )
  return port
}

const roots: string[] = []
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'slz-secrets-at-rest-'))
  roots.push(root)
  return root
}

// --- requests -------------------------------------------------------------------

const PUBLIC = 'hub.example.com'
const ORIGIN = `https://${PUBLIC}`

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: Record<string, unknown>; token: string | null }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body)
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, json, token: res.headers.get('set-auth-token') }
}

async function signIn(port: number, email: string, password: string): Promise<string> {
  const r = await postJson(`http://127.0.0.1:${port}/api/auth/sign-in/email`, { email, password })
  expect(r.status, `sign-in as ${email}: ${r.status} ${JSON.stringify(r.json)}`).toBe(200)
  assert(r.token, `sign-in as ${email}: ${r.status} ${JSON.stringify(r.json)}`)
  return r.token
}

async function mintJoinToken(port: number, bearer: string): Promise<string> {
  const minted = await poll(
    async () => {
      const r = await postJson(
        `http://127.0.0.1:${port}/api/computers/join-token`,
        // T-20: minted FOR a named user (the bootstrap owner, who also mints here).
        { label: 'secrets-at-rest', forUser: BOOTSTRAP_OWNER_EMAIL },
        { authorization: `Bearer ${bearer}` }
      )
      return r.status === 200 ? (r.json as { token: string }) : null
    },
    20_000,
    'join token mint'
  )
  return minted.token
}

/** One JSON-RPC request on `/computers`, the way a computer authenticates. */
async function computerRpc(
  port: number,
  method: 'enroll' | 'hello',
  params: Record<string, unknown>
): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/computers`)
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    const reply = new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>(
      (resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no ${method} response`)), 15_000)
        ws.on('message', (data) => {
          for (const line of String(data).split('\n')) {
            if (!line.trim()) continue
            const frame = JSON.parse(line) as { id?: unknown; result?: never; error?: never }
            if (frame.id === 1) {
              clearTimeout(t)
              resolve(frame)
            }
          }
        })
      }
    )
    ws.send(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`)
    return await reply
  } finally {
    ws.terminate()
  }
}

async function enroll(port: number, joinToken: string): Promise<string> {
  const r = await computerRpc(port, 'enroll', {
    joinToken,
    name: `secrets-at-rest-${randomBytes(3).toString('hex')}`,
    platform: `${process.platform}-${process.arch}`,
    version: '0.0.0-test',
    capabilities: [],
    protocolVersion: COMPUTER_PROTOCOL_VERSION
  })
  const apiKey = r.result?.apiKey
  assert(typeof apiKey === 'string' && apiKey, `enroll: ${JSON.stringify(r)}`)
  return apiKey
}

/**
 * Fails with the hub's reply unless a reconnect with `apiKey` gets the computer in.
 * Sent the way the computer's dialer sends it: since v3 (T-27) `hello` carries the
 * protocol version (a hub refuses one without), and the computer stays only if the
 * hub echoes its own.
 */
async function assertHello(port: number, apiKey: string, label: string): Promise<void> {
  const r = await computerRpc(port, 'hello', {
    apiKey,
    protocolVersion: COMPUTER_PROTOCOL_VERSION
  })
  expect(typeof r.result?.computerId, `${label}: ${JSON.stringify(r)}`).toBe('string')
  expect(r.result?.protocolVersion, `${label}: ${JSON.stringify(r)}`).toBe(
    COMPUTER_PROTOCOL_VERSION
  )
}

// --- what may never show up -----------------------------------------------------

/** The secret as typed, and every encoding a log line or file could carry it in. */
function forms(secret: string): string[] {
  const out = [
    secret,
    Buffer.from(secret, 'utf8').toString('hex'),
    Buffer.from(secret, 'utf8').toString('base64'),
    Buffer.from(secret, 'utf8').toString('base64url')
  ]
  // `openssl rand -hex 32`: the bytes it stands for, too.
  if (/^[0-9a-f]+$/i.test(secret) && secret.length % 2 === 0) {
    const bytes = Buffer.from(secret, 'hex')
    out.push(bytes.toString('base64'), bytes.toString('base64url'))
  }
  return out
}

/** Everything under `<root>/logs`. */
function readLogs(root: string): string {
  const dir = join(root, 'logs')
  if (!existsSync(dir)) return ''
  return readdirSync(dir)
    .map((n) => readFileSync(join(dir, n), 'utf8'))
    .join('\n')
}

/** Every file under `root`, recursively, with its bytes. */
function allFiles(root: string): Array<{ path: string; bytes: Buffer }> {
  const out: Array<{ path: string; bytes: Buffer }> = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...allFiles(full))
    else out.push({ path: relative(root, full), bytes: readFileSync(full) })
  }
  return out
}

/** Fails naming the first secret found in the logs + output, and where. */
function assertNotLogged(root: string, hub: Hub, secrets: Record<string, string[]>): void {
  const text = `${readLogs(root)}\n${hub.logs.join('\n')}`
  expect(text.length, 'something was logged, so the check is not vacuous').toBeGreaterThan(0)
  for (const [what, values] of Object.entries(secrets)) {
    for (const v of values) expect(text.includes(v), `${what} appears in a log line`).toBe(false)
  }
}

/** Fails naming the first file under ROOT that holds one of `secrets`. */
function assertNotOnDisk(root: string, secrets: Record<string, string[]>): void {
  const files = allFiles(root)
  for (const [what, values] of Object.entries(secrets)) {
    for (const v of values) {
      const hit = files.find((f) => f.bytes.includes(v))
      expect(hit, `${what} is on disk in ${hit?.path}`).toBeUndefined()
    }
  }
}

function writeSsoCert(root: string): { certPath: string; keyPath: string } {
  const certPath = join(root, 'sso-cert.pem')
  const keyPath = join(root, 'sso-key.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=slayzone-secrets-at-rest',
      '-keyout',
      keyPath,
      '-out',
      certPath
    ],
    { stdio: 'ignore' }
  )
  return { certPath, keyPath }
}

/** The base64 body of a PEM key, in 40-char slices (a partial leak counts). */
function keySlices(keyPath: string): string[] {
  const body = readFileSync(keyPath, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('-----'))
    .join('')
  const out: string[] = []
  for (let i = 0; i + 40 <= body.length; i += 40) out.push(body.slice(i, i + 40))
  return out
}

// --- the cases ------------------------------------------------------------------

beforeAll(() => ensureBuilt())

const LOOP = { SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0' }
const reachable = (secret: string): Record<string, string> => ({
  ...LOOP,
  SLAYZONE_HUB_PUBLIC_ADDRESS: PUBLIC,
  SLAYZONE_HUB_REQUIRE_LOGIN: '1',
  SLAYZONE_HUB_AUTH_SECRET: secret
})

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

test('password hub: full boot and use — no generated secret under ROOT, none in any log', async () => {
  const root = newRoot()
  const secret = randomBytes(32).toString('hex')
  const ownerPassword = deriveBootstrapOwnerPassword(secret)
  const hub = spawnHub(root, reachable(secret))
  let bearer: string
  let joinToken: string
  let apiKey: string
  let created: string
  try {
    const port = await bootAndGetPort(hub)
    // The owner exists with no file: its password derives from the secret.
    bearer = await signIn(port, BOOTSTRAP_OWNER_EMAIL, ownerPassword)
    const wrong = await postJson(`http://127.0.0.1:${port}/api/auth/sign-in/email`, {
      email: BOOTSTRAP_OWNER_EMAIL,
      password: `${ownerPassword}x`
    })
    expect(wrong.status, `a wrong password is refused, got ${wrong.status}`).toBe(401)
    joinToken = await mintJoinToken(port, bearer)
    apiKey = await enroll(port, joinToken)
    await assertHello(port, apiKey, 'the enrolled computer says hello')
    const add = await postJson(
      `http://127.0.0.1:${port}/api/hub/users`,
      { email: 'someone@example.com' },
      { authorization: `Bearer ${bearer}` }
    )
    created = (add.json.data as { password?: string } | undefined)?.password ?? ''
    expect(add.status, `users add: ${add.status} ${JSON.stringify(add.json)}`).toBe(200)
    expect(created, `users add: ${add.status} ${JSON.stringify(add.json)}`).not.toBe('')
    await signIn(port, 'someone@example.com', created)
  } finally {
    await hub.stop()
  }

  for (const name of ['hub.state.json', 'hub.owner.json', 'hub.break-glass.json', 'identity']) {
    expect(existsSync(join(root, name)), `no ${name} under ROOT`).toBe(false)
  }
  const joinSecret = (
    JSON.parse(Buffer.from(joinToken.split('.')[1]!, 'base64url').toString('utf8')) as {
      secret: string
    }
  ).secret
  const never = {
    'the auth secret': forms(secret),
    'the derived owner password': [ownerPassword],
    'a generated account password': [created],
    'the join token': [joinToken, joinSecret],
    'the computer API key': [apiKey]
  }
  assertNotOnDisk(root, never)
  assertNotLogged(root, hub, { ...never, 'a session bearer': [bearer] })
})

test('SSO hub with break-glass used: no break-glass file; verifier and session token on no disk, in no log', async () => {
  const root = newRoot()
  const secret = randomBytes(32).toString('hex')
  const { certPath, keyPath } = writeSsoCert(root)
  const hub = spawnHub(root, {
    ...reachable(secret),
    SLAYZONE_HUB_ENABLE_SSO: '1',
    SLAYZONE_HUB_ENABLE_PASSWORD: '0',
    SLAYZONE_HUB_SSO_TENANT_ID: '11111111-2222-3333-4444-555555555555',
    SLAYZONE_HUB_SSO_CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    SLAYZONE_HUB_SSO_CERT_PATH: certPath,
    SLAYZONE_HUB_SSO_KEY_PATH: keyPath
  })
  const verifier = randomBytes(32).toString('base64url')
  let bearer = ''
  try {
    const port = await bootAndGetPort(hub)
    // Break-glass v2: a grant over the local socket, redeemed with the verifier.
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const open = runBin(['break-glass', 'open', '--challenge', challenge, '--root', root])
    expect(open.code, `break-glass open: ${open.out}`).toBe(0)
    const redeemed = await postJson(`http://127.0.0.1:${port}/api/auth/break-glass`, {
      verifier
    })
    bearer = typeof redeemed.json.token === 'string' ? redeemed.json.token : ''
    expect(redeemed.status, `break-glass redeem: ${redeemed.status}`).toBe(200)
    expect(bearer, `break-glass redeem: ${redeemed.status}`).not.toBe('')
    const users = await fetch(`http://127.0.0.1:${port}/api/hub/users`, {
      headers: { authorization: `Bearer ${bearer}` }
    })
    expect(users.status, `the session works, got ${users.status}`).toBe(200)
    // Entra sign-in: start (builds the authorize URL, reaches no one) and a callback
    // with an error — the SSO error path, without Microsoft.
    const start = await postJson(`http://127.0.0.1:${port}/api/auth/sign-in/social`, {
      provider: 'microsoft',
      callbackURL: '/',
      disableRedirect: true
    })
    expect(start.status, `sign-in/social, got ${start.status}`).toBe(200)
    const cb = await fetch(
      `http://127.0.0.1:${port}/api/auth/callback/microsoft?error=access_denied&state=nope`,
      { redirect: 'manual' }
    )
    expect(cb.status, `callback, got ${cb.status}`).toBe(302)
  } finally {
    await hub.stop()
  }
  for (const name of ['hub.state.json', 'hub.owner.json', 'hub.break-glass.json']) {
    expect(existsSync(join(root, name)), `no ${name} under ROOT`).toBe(false)
  }
  // The certificate and key are the operator's own files (paths in env).
  const files = allFiles(root).filter((f) => f.path !== 'sso-key.pem')
  for (const v of [...forms(secret), verifier, bearer]) {
    const hit = files.find((f) => f.bytes.includes(v))
    expect(hit, `a secret is on disk in ${hit?.path}`).toBeUndefined()
  }
  assertNotLogged(root, hub, {
    'the auth secret': forms(secret),
    'the break-glass verifier': [verifier],
    'the break-glass session': [bearer],
    'the SSO private key': [...keySlices(keyPath), 'PRIVATE KEY']
  })
})

test('boot refusals and SSO credential errors print no secret', async () => {
  const secret = randomBytes(32).toString('hex')
  // B10 with the secret set; B7 with a key file that does not parse.
  const root = newRoot()
  const badKey = join(root, 'bad-key.pem')
  const junk = randomBytes(48).toString('base64')
  writeFileSync(badKey, `-----BEGIN PRIVATE KEY-----\n${junk}\n-----END PRIVATE KEY-----\n`)
  const { certPath } = writeSsoCert(root)
  const cases: Array<[string, Record<string, string>, string]> = [
    ['B10', { ...reachable(secret), PLAYWRIGHT: '1' }, 'PLAYWRIGHT=1'],
    [
      'B7',
      {
        ...reachable(secret),
        SLAYZONE_HUB_ENABLE_SSO: '1',
        SLAYZONE_HUB_ENABLE_PASSWORD: '0',
        SLAYZONE_HUB_SSO_TENANT_ID: '11111111-2222-3333-4444-555555555555',
        SLAYZONE_HUB_SSO_CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        SLAYZONE_HUB_SSO_CERT_PATH: certPath,
        SLAYZONE_HUB_SSO_KEY_PATH: badKey
      },
      'does not parse'
    ]
  ]
  for (const [rule, env, needle] of cases) {
    const hub = spawnHub(root, env)
    try {
      const code = await hub.exit
      expect(code, `${rule}: refused, exit ${code}`).not.toBe(0)
      const out = hub.logs.join('\n')
      expect(out, `${rule}: ${out}`).toContain(needle)
      expect(out, `${rule}: ${out}`).toContain(`"rule":"${rule}"`)
      for (const v of [...forms(secret), junk.slice(0, 40)]) {
        expect(out, `${rule}: a secret is in the output`).not.toContain(v)
      }
    } finally {
      await hub.stop()
    }
  }
  expect(existsSync(join(root, 'hub.state.json')), 'no state file from a refusal').toBe(false)
})

// --- compat: a hub that generated its secret while loopback-only -------------
test('upgrade: a loopback hub published with its own secret in env keeps every session and computer; files untouched', async () => {
  const root = newRoot()
  // Before: loopback-only with login — it generates its secret and owner file, as today.
  const before = spawnHub(root, { ...LOOP, SLAYZONE_HUB_REQUIRE_LOGIN: '1' })
  let ownerToken: string
  let apiKeyBefore: string
  try {
    const port = await bootAndGetPort(before)
    ownerToken = (
      JSON.parse(readFileSync(join(root, 'hub.owner.json'), 'utf8')) as { token: string }
    ).token
    apiKeyBefore = await enroll(port, await mintJoinToken(port, ownerToken))
  } finally {
    await before.stop()
  }
  const statePath = join(root, 'hub.state.json')
  const ownerPath = join(root, 'hub.owner.json')
  const secret = (
    JSON.parse(readFileSync(statePath, 'utf8')) as { computerTransportSecret: string }
  ).computerTransportSecret
  const snapshot = (p: string) => ({
    body: readFileSync(p, 'utf8'),
    mtime: statSync(p).mtimeMs
  })
  const stateBefore = snapshot(statePath)
  const ownerBefore = snapshot(ownerPath)

  // After: reachable, the operator copies the secret into env (B14's instruction).
  const after = spawnHub(root, reachable(secret))
  try {
    const port = await bootAndGetPort(after)
    const tasks = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      headers: { authorization: `Bearer ${ownerToken}` }
    })
    expect(tasks.status, `a session from before still works, got ${tasks.status}`).toBe(200)
    await assertHello(port, apiKeyBefore, 'a computer enrolled before still connects')
    const apiKeyAfter = await enroll(port, await mintJoinToken(port, ownerToken))
    await assertHello(port, apiKeyAfter, 'a computer enrolled after connects')
    const out = after.logs.join('\n')
    expect(out, `names both files:\n${out}`).toContain(statePath)
    expect(out, `names both files:\n${out}`).toContain(ownerPath)
  } finally {
    await after.stop()
  }
  for (const [p, was] of [
    [statePath, stateBefore],
    [ownerPath, ownerBefore]
  ] as const) {
    const now = snapshot(p)
    expect(now.body, `${p} untouched`).toBe(was.body)
    expect(now.mtime, `${p} untouched`).toBe(was.mtime)
  }
  assertNotLogged(root, after, { 'the auth secret': forms(secret) })

  // A DIFFERENT secret: refused (B17) before anything is opened or written.
  const other = randomBytes(32).toString('hex')
  const refused = spawnHub(root, reachable(other))
  try {
    const code = await refused.exit
    expect(code, `refused, exit ${code}`).not.toBe(0)
    const out = refused.logs.join('\n')
    expect(out, `B17 naming the file:\n${out}`).toContain('"rule":"B17"')
    expect(out, `B17 naming the file:\n${out}`).toContain(statePath)
    for (const v of [...forms(secret), ...forms(other)]) {
      expect(out, 'no secret value in the refusal').not.toContain(v)
    }
  } finally {
    await refused.stop()
  }
  expect(snapshot(statePath).mtime, 'state file untouched by the refusal').toBe(stateBefore.mtime)
})
