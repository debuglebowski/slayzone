/**
 * N1: on a hub with login, a hub-local path procedure opens a path only inside a root
 * the caller may access — through the REAL built hub (dist/bin.cjs) in its own
 * process, so `/dev/fd/<n>` is the HUB's file descriptor table, as in the attack.
 *
 * It used to: a path in no project root was hub-wide (access.ts), so user B's
 * `artifacts.upload({ sourcePath: '/dev/fd/<n>' })` copied the hub's open database
 * into an artifact B could read (`SQLite format 3`), and on Linux
 * `/proc/self/environ` handed B `SLAYZONE_HUB_AUTH_SECRET` — which signs sessions and
 * derives the bootstrap owner's password: an admin takeover.
 *
 * Two hubs:
 *   - a shared hub (login on, processes on — the default), signed-in user B
 *   - the desktop app's (`SLAYZONE_SUPERVISED=1`, login off): a path in no root is
 *     still copied, exactly as before
 *
 * Native ABI: better-sqlite3 in the hub needs Electron's node.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/hub-local-path-reads.test.ts
 */
import { TEST_ISOLATION_ENV } from '../../../shared/test-utils/caller-env.js'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTRPCClient, createWSClient, TRPCClientError, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { afterAll, assert, beforeAll, describe, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const PACKAGES_DIR = join(HUB_DIR, '..', '..')
const ELECTRON_BIN = require('electron') as unknown as string
const SECRET = 'hub-local-path-reads-test-signing-secret-0123456789'

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

/** The bundle inlines every workspace package (the fix is in `@slayzone/api`). */
function ensureBuilt(): void {
  const stale = !existsSync(HUB_BIN) || newestMtime(PACKAGES_DIR) > statSync(HUB_BIN).mtimeMs
  if (!stale) return
  console.log('  … building hub bundle (bin missing or stale)')
  execFileSync('node', ['build.mjs'], { cwd: HUB_DIR, stdio: 'inherit' })
  if (!existsSync(HUB_BIN)) throw new Error(`hub build did not produce ${HUB_BIN}`)
}

function scrubbedEnv(home: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null || (/^(SLAYZONE_|ELECTRON_)/.test(k) && !TEST_ISOLATION_ENV.has(k))) continue
    out[k] = v
  }
  return { ...out, HOME: home }
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

interface Hub {
  root: string
  port: number
  pid: number
  logs: string[]
  stop: () => Promise<void>
}

async function bootHub(env: Record<string, string>): Promise<Hub> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'slz-hub-path-reads-')))
  const logs: string[] = []
  // stdin held open: a hub started by the desktop app treats stdin EOF as "parent died".
  const proc: ChildProcess = spawn(ELECTRON_BIN, [HUB_BIN], {
    cwd: root,
    env: {
      ...scrubbedEnv(root),
      ...env,
      SLAYZONE_ROOT: root,
      SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
      ELECTRON_RUN_AS_NODE: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const cap = (b: Buffer): void => {
    for (const line of b.toString().split('\n')) if (line.trim()) logs.push(line)
  }
  proc.stdout?.on('data', cap)
  proc.stderr?.on('data', cap)
  const alive = (): boolean => proc.exitCode === null && proc.signalCode === null
  const stop = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const done = (): void => {
        rmSync(root, { recursive: true, force: true })
        resolve()
      }
      if (!alive()) return done()
      const t = setTimeout(() => proc.kill('SIGKILL'), 5_000)
      proc.once('exit', () => {
        clearTimeout(t)
        done()
      })
      proc.kill('SIGTERM')
    })
  try {
    const line = await poll(
      async () => logs.find((l) => l.includes('listening on http://')) ?? null,
      40_000,
      `hub listening line (logs:\n${logs.join('\n')})`
    )
    const m = line.match(/http:\/\/[^:]+:(\d+)/)
    assert(m, `listening line parseable: ${line}`)
    const port = Number(m[1])
    await poll(
      async () => {
        const r = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(1000)
        })
        return r.ok ? true : null
      },
      15_000,
      'hub /health ok'
    )
    assert(proc.pid, 'hub pid')
    return { root, port, pid: proc.pid, logs, stop }
  } catch (err) {
    await stop()
    throw err
  }
}

/** The hub process's descriptor of its own database (`<ROOT>/…sqlite`). */
function hubDbFd(hub: Hub): number {
  const isDb = (name: string): boolean =>
    name.startsWith(hub.root) && /\.sqlite$/.test(name) && !/auth/.test(name)
  if (process.platform === 'linux') {
    for (const fd of readdirSync(`/proc/${hub.pid}/fd`)) {
      const target = (() => {
        try {
          return readlinkSync(`/proc/${hub.pid}/fd/${fd}`)
        } catch {
          return ''
        }
      })()
      if (isDb(target)) return Number(fd)
    }
  } else {
    // `-F fn`: one `f<fd>` line, then its `n<name>` line.
    const out = execFileSync('lsof', ['-a', '-p', String(hub.pid), '-F', 'fn'], {
      encoding: 'utf8'
    })
    let fd = -1
    for (const line of out.split('\n')) {
      if (line.startsWith('f')) fd = Number(line.slice(1))
      else if (line.startsWith('n') && Number.isInteger(fd) && fd >= 0 && isDb(line.slice(1)))
        return fd
    }
  }
  throw new Error(`no open database descriptor in hub ${hub.pid}`)
}

/** A `user` account, created by the bootstrap owner (the admin) and signed in. */
async function signedInUser(hub: Hub): Promise<string> {
  const admin = (
    JSON.parse(readFileSync(join(hub.root, 'hub.owner.json'), 'utf8')) as { token: string }
  ).token
  const email = 'b@example.com'
  const created = await fetch(`http://127.0.0.1:${hub.port}/api/hub/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: JSON.stringify({ email })
  })
  const body = (await created.json()) as { data: { password: string } }
  expect(created.ok, `create user: ${created.status} ${JSON.stringify(body)}`).toBe(true)
  // better-auth checks the Origin of a sign-in; the hub's auth base URL is trusted.
  const signIn = await fetch(`http://127.0.0.1:${hub.port}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8788' },
    body: JSON.stringify({ email, password: body.data.password })
  })
  const session = (await signIn.json()) as { token?: string }
  expect(signIn.ok, `sign in: ${signIn.status}`).toBe(true)
  assert(session.token, `sign in: ${signIn.status}`)
  return session.token
}

async function rest(hub: Hub, token: string | null, path: string, body: unknown): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${hub.port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  })
  const json = (await res.json()) as { data?: { id: string } }
  expect(res.ok, `POST ${path}: ${res.status} ${JSON.stringify(json)}`).toBe(true)
  assert(json.data?.id, `POST ${path}: ${JSON.stringify(json)}`)
  return json.data.id
}

type Proc = {
  mutate: (input?: unknown) => Promise<unknown>
  query: (input?: unknown) => Promise<unknown>
}
type Client = { artifacts: Record<'upload' | 'readContent', Proc> }

function hubClient(hub: Hub, token: string | null): { client: Client; close: () => void } {
  const ws = createWSClient({
    url: `ws://127.0.0.1:${hub.port}/trpc?windowId=7`,
    connectionParams: token ? { token } : undefined
  })
  const client = createTRPCClient({
    links: [wsLink({ client: ws, transformer: superjson })]
  }) as unknown as Client
  return { client, close: () => ws.close() }
}

/** What an upload of `sourcePath` gave the caller: the copied text, or the error code. */
async function upload(client: Client, taskId: string, sourcePath: string): Promise<string> {
  try {
    const art = (await client.artifacts.upload.mutate({ taskId, sourcePath })) as { id: string }
    return String(await client.artifacts.readContent.query({ id: art.id }))
  } catch (e) {
    if (e instanceof TRPCClientError) return `ERR:${String((e.data as { code?: string })?.code)}`
    throw e
  }
}

beforeAll(() => ensureBuilt(), 300_000)

describe('a shared hub (login on, processes on)', () => {
  let hub: Hub
  let client: Client
  let close = (): void => undefined
  let taskId = ''
  let outside = ''
  beforeAll(async () => {
    hub = await bootHub({
      SLAYZONE_HUB_REQUIRE_LOGIN: '1',
      SLAYZONE_HUB_AUTH_SECRET: SECRET
    })
    const token = await signedInUser(hub)
    const projectId = await rest(hub, token, '/api/projects', { name: 'B' })
    taskId = await rest(hub, token, '/api/tasks', { projectId, title: 'b' })
    const c = hubClient(hub, token)
    client = c.client
    close = c.close
    // A file in nobody's project root, outside the hub's state directory.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slz-nobodys-')))
    mkdirSync(dir, { recursive: true })
    outside = join(dir, 'loose.txt')
    writeFileSync(outside, 'NOBODYS')
  }, 120_000)
  afterAll(async () => {
    close()
    await hub?.stop()
    if (outside) rmSync(dirname(outside), { recursive: true, force: true })
  })

  test("user B uploading /dev/fd/<the hub's database>: refused, nothing copied", async () => {
    const fd = hubDbFd(hub)
    const got = await upload(client, taskId, `/dev/fd/${fd}`)
    expect(got.startsWith('SQLite format 3'), 'the hub database leaked').toBe(false)
    expect(got).toBe('ERR:NOT_FOUND')
  })

  test.runIf(process.platform === 'linux')(
    "user B uploading /proc/self/environ (the hub's auth secret): refused",
    async () => {
      const got = await upload(client, taskId, '/proc/self/environ')
      expect(got.includes(SECRET), 'SLAYZONE_HUB_AUTH_SECRET leaked').toBe(false)
      expect(got).toBe('ERR:NOT_FOUND')
    }
  )

  test('user B uploading a file in no project root: refused (never hub-wide)', async () => {
    expect(await upload(client, taskId, outside)).toBe('ERR:NOT_FOUND')
  })
})

describe("the desktop app's hub (login off): as before", () => {
  let hub: Hub
  let client: Client
  let close = (): void => undefined
  let taskId = ''
  let outside = ''
  beforeAll(async () => {
    hub = await bootHub({ SLAYZONE_SUPERVISED: '1' })
    const projectId = await rest(hub, null, '/api/projects', { name: 'P' })
    taskId = await rest(hub, null, '/api/tasks', { projectId, title: 't' })
    const c = hubClient(hub, null)
    client = c.client
    close = c.close
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slz-nobodys-')))
    outside = join(dir, 'loose.txt')
    writeFileSync(outside, 'NOBODYS')
  }, 120_000)
  afterAll(async () => {
    close()
    await hub?.stop()
    if (outside) rmSync(dirname(outside), { recursive: true, force: true })
  })

  test('a file in no project root is copied', async () => {
    expect(await upload(client, taskId, outside)).toBe('NOBODYS')
  })
})
