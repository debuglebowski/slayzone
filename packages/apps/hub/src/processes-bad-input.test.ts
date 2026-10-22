/**
 * A bad `processes.*` input is a clean error and the hub stays up (T-102), through the
 * REAL built hub (dist/bin.cjs) in its own process, so a crash is the child exiting —
 * not this test dying with it.
 *
 * It used to: `processes.create` with no `label` passed straight to the process
 * manager, whose `void persistence.insert(…)` hit SQLite's NOT NULL and rejected with
 * nobody listening. An unhandled rejection ends a Node process, so any signed-in user
 * could take a shared hub down. A valid-shaped input the database refuses (a task that
 * does not exist: FOREIGN KEY) took the same path, and a spawn in a cwd that does not
 * exist threw the child's unheard 'error' event out of the hub.
 *
 * Three hubs:
 *   - the desktop app's (`SLAYZONE_SUPERVISED=1`, login off, processes on)
 *   - a shared hub with processes on (login on, a signed-in `user`)
 *   - Normain's (login on, `SLAYZONE_HUB_ENABLE_PROCESSES=0`)
 *
 * Each bad input answers an error (BAD_REQUEST where the input reaches validation;
 * NOT_FOUND where the owner gate (T-17) refuses an input naming nothing of the
 * caller's first), then the hub still answers and its process is still running. A
 * valid create still works where processes are on, and is refused where they are off.
 *
 * Native ABI: better-sqlite3 in the hub needs Electron's node.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --experimental-loader ./packages/shared/test-utils/loader.ts \
 *   packages/apps/hub/src/processes-bad-input.test.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTRPCClient, createWSClient, TRPCClientError, wsLink } from '@trpc/client'
import superjson from 'superjson'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const PACKAGES_DIR = join(HUB_DIR, '..', '..')
const ELECTRON_BIN = require('electron') as unknown as string
const SECRET = 'processes-bad-input-test-signing-secret-0123456789'

let passed = 0
let failed = 0
async function test(name: string, fn: () => Promise<void>): Promise<void> {
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

/** Newest source mtime under `dir`, skipping build output and dependencies. */
function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

/** The bundle inlines every workspace package (the fix is in transport and processes),
 *  so staleness is judged on all of them. */
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
    if (v == null || /^(SLAYZONE_|ELECTRON_)/.test(k)) continue
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Hub {
  root: string
  port: number
  logs: string[]
  alive: () => boolean
  stop: () => Promise<void>
}

async function bootHub(env: Record<string, string>): Promise<Hub> {
  const root = mkdtempSync(join(tmpdir(), 'slz-processes-bad-input-'))
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
    return { root, port, logs, alive, stop }
  } catch (err) {
    await stop()
    throw err
  }
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
  assert(created.ok, `create user: ${created.status} ${JSON.stringify(body)}`)
  // better-auth checks the Origin of a sign-in; the hub's auth base URL is trusted.
  const signIn = await fetch(`http://127.0.0.1:${hub.port}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8788' },
    body: JSON.stringify({ email, password: body.data.password })
  })
  const session = (await signIn.json()) as { token?: string }
  assert(signIn.ok && session.token, `sign in: ${signIn.status}`)
  return session.token
}

/** A project the caller owns (REST stamps the creator on a hub with login). */
async function createProject(hub: Hub, token: string | null): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${hub.port}/api/projects`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ name: 'P' })
  })
  const body = (await res.json()) as { data?: { id: string } }
  assert(res.ok && body.data?.id, `create project: ${res.status} ${JSON.stringify(body)}`)
  return body.data.id
}

type Proc = {
  mutate: (input?: unknown) => Promise<unknown>
  query: (input?: unknown) => Promise<unknown>
}
type Client = {
  processes: Record<'create' | 'spawn' | 'update' | 'listAll', Proc>
  hub: { describe: Proc }
}

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

/** A call to a hub that died never settles (the socket keeps reconnecting): bound it. */
function bounded<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${what}: no answer in 10s`)), 10_000)
    )
  ])
}

/** The error code a call answered, or `ok` when it succeeded. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await bounded(p, 'call')
    return 'ok'
  } catch (e) {
    if (e instanceof TRPCClientError) return String((e.data as { code?: string })?.code)
    throw e
  }
}

/**
 * After a bad call: give an unhandled rejection its turn (it fires after the response
 * is sent), then the process must still be running and answer the next request.
 */
async function stillUp(hub: Hub, client: Client, after: string): Promise<void> {
  await sleep(250)
  assert(
    hub.alive(),
    `hub process exited after ${after}; last lines:\n${hub.logs.slice(-15).join('\n')}`
  )
  const list = await bounded(client.processes.listAll.query(), `listAll after ${after}`)
  assert(Array.isArray(list), `next request answers after ${after}`)
}

const LONG = 'x'.repeat(100_000)

async function runHub(
  name: string,
  env: Record<string, string>,
  opts: { login: boolean; processes: boolean }
): Promise<void> {
  const hub = await bootHub(env)
  let close = (): void => undefined
  try {
    const token = opts.login ? await signedInUser(hub) : null
    const projectId = await createProject(hub, token)
    const c = hubClient(hub, token)
    close = c.close
    const { client } = c
    const valid = {
      projectId,
      taskId: null,
      label: 'dev',
      command: 'echo hi',
      cwd: '/tmp',
      autoRestart: false
    }
    // Without an id of the caller's, the owner gate answers before validation (T-17).
    const noOwnedId = opts.login ? 'NOT_FOUND' : 'BAD_REQUEST'

    const cases: Array<[string, () => Promise<unknown>, string]> = []
    for (const op of ['create', 'spawn'] as const) {
      const call = (input: unknown) => () => client.processes[op].mutate(input)
      const { label: _label, ...noLabel } = valid
      cases.push(
        [`${op} without label`, call(noLabel), 'BAD_REQUEST'],
        [`${op} with label null`, call({ ...valid, label: null }), 'BAD_REQUEST'],
        [`${op} with an empty label`, call({ ...valid, label: '' }), 'BAD_REQUEST'],
        [`${op} with a blank label`, call({ ...valid, label: '   ' }), 'BAD_REQUEST'],
        [`${op} with an oversized label`, call({ ...valid, label: LONG }), 'BAD_REQUEST'],
        [`${op} with a number label`, call({ ...valid, label: 5 }), 'BAD_REQUEST'],
        [`${op} without command`, call({ ...valid, command: undefined }), 'BAD_REQUEST'],
        [`${op} with an oversized command`, call({ ...valid, command: LONG }), 'BAD_REQUEST'],
        [`${op} with cwd null`, call({ ...valid, cwd: null }), 'BAD_REQUEST'],
        [`${op} with autoRestart "yes"`, call({ ...valid, autoRestart: 'yes' }), 'BAD_REQUEST'],
        [`${op} with no input`, call(undefined), noOwnedId],
        [`${op} with input null`, call(null), noOwnedId],
        [`${op} with a string input`, call('garbage'), noOwnedId],
        [`${op} with an array input`, call([valid]), noOwnedId]
      )
    }
    // Valid shape, refused by the database: a task that does not exist. With login the
    // owner gate refuses it first; on the desktop's hub it reaches the insert.
    cases.push([
      'create naming a task that does not exist',
      () => client.processes.create.mutate({ ...valid, projectId: null, taskId: 'no-such-task' }),
      opts.login ? 'NOT_FOUND' : opts.processes ? 'INTERNAL_SERVER_ERROR' : 'FORBIDDEN'
    ])

    for (const [label, call, want] of cases) {
      await test(`${name}: ${label} → ${want}, hub stays up`, async () => {
        assert(hub.alive(), 'hub already down')
        const got = await codeOf(call())
        assert(got === want, `${label}: expected ${want}, got ${got}`)
        await stillUp(hub, client, label)
      })
    }

    if (opts.processes) {
      let id = ''
      await test(`${name}: a valid create still works`, async () => {
        id = String(await bounded(client.processes.create.mutate(valid), 'valid create'))
        const rows = (await bounded(client.processes.listAll.query(), 'listAll')) as Array<{
          id: string
          label: string
          command: string
          cwd: string
          status: string
        }>
        const row = rows.find((r) => r.id === id)
        assert(row, 'the created process lists')
        assert(
          row.label === 'dev' && row.command === 'echo hi' && row.cwd === '/tmp',
          `row as sent: ${JSON.stringify(row)}`
        )
        assert(row.status === 'stopped', 'created, not spawned')
      })
      const update = (updates: unknown) => () =>
        client.processes.update.mutate({ processId: id, updates })
      for (const [label, call] of [
        ['update with label null', update({ label: null })],
        ['update with an empty label', update({ label: '' })],
        ['update with an oversized command', update({ command: LONG })],
        ['update with cwd null', update({ cwd: null })],
        ['update with a field that is not editable (pid)', update({ pid: 1 })],
        ['update with a field that is not editable (logBuffer)', update({ logBuffer: 'x' })],
        ['update with updates null', update(null)]
      ] as const) {
        await test(`${name}: ${label} → BAD_REQUEST, hub stays up`, async () => {
          assert(hub.alive(), 'hub already down')
          const got = await codeOf(call())
          assert(got === 'BAD_REQUEST', `${label}: expected BAD_REQUEST, got ${got}`)
          await stillUp(hub, client, label)
        })
      }
      if (!opts.login) {
        await test(`${name}: update naming a task that does not exist → INTERNAL_SERVER_ERROR, nothing changed`, async () => {
          const got = await codeOf(update({ taskId: 'no-such-task' })())
          assert(got === 'INTERNAL_SERVER_ERROR', `expected INTERNAL_SERVER_ERROR, got ${got}`)
          await stillUp(hub, client, 'update naming a missing task')
          const rows = (await bounded(client.processes.listAll.query(), 'listAll')) as Array<{
            id: string
            taskId: string | null
          }>
          assert(rows.find((r) => r.id === id)?.taskId === null, 'the refused update left the row')
        })
      }
      await test(`${name}: a valid update still works`, async () => {
        const ok = await bounded(
          client.processes.update.mutate({
            processId: id,
            updates: { label: 'renamed', command: 'echo bye', autoRestart: true }
          }),
          'valid update'
        )
        assert(ok === true, 'update answers true')
        const rows = (await bounded(client.processes.listAll.query(), 'listAll')) as Array<{
          id: string
          label: string
          command: string
          autoRestart: boolean
        }>
        const row = rows.find((r) => r.id === id)
        assert(
          row?.label === 'renamed' && row.command === 'echo bye' && row.autoRestart === true,
          `row updated: ${JSON.stringify(row)}`
        )
      })
      // Valid input whose spawn fails after `spawn()` returned: the child reports a
      // missing cwd as an 'error' event, which nobody listened for.
      await test(`${name}: spawn in a cwd that does not exist → answers, the process errors, hub stays up`, async () => {
        const spawned = String(
          await bounded(
            client.processes.spawn.mutate({ ...valid, label: 'nowhere', cwd: '/no/such/dir-t102' }),
            'spawn'
          )
        )
        await stillUp(hub, client, 'spawn in a missing cwd')
        const row = await poll(
          async () => {
            const rows = (await client.processes.listAll.query()) as Array<{
              id: string
              status: string
              logBuffer: string[]
            }>
            const r = rows.find((x) => x.id === spawned)
            return r?.status === 'error' ? r : null
          },
          5_000,
          'the process to report error'
        )
        assert(
          row.logBuffer.some((l) => l.includes('failed to start')),
          `the reason is in its log: ${JSON.stringify(row.logBuffer)}`
        )
      })
    } else {
      for (const op of ['create', 'spawn'] as const) {
        await test(`${name}: a valid ${op} is refused by the switch, hub stays up`, async () => {
          const got = await codeOf(client.processes[op].mutate(valid))
          assert(got === 'FORBIDDEN', `expected FORBIDDEN, got ${got}`)
          await stillUp(hub, client, `a valid ${op}`)
        })
      }
    }

    await test(`${name}: the hub process is still running at the end`, async () => {
      await sleep(500)
      assert(hub.alive(), `hub exited; last lines:\n${hub.logs.slice(-15).join('\n')}`)
      const r = await fetch(`http://127.0.0.1:${hub.port}/health`)
      assert(r.ok, '/health answers')
    })
  } finally {
    close()
    await hub.stop()
  }
}

async function main(): Promise<void> {
  console.log('\nbad processes.* input on a real built hub: a clean error, never an exit\n')
  ensureBuilt()
  await runHub(
    'desktop hub (login off, processes on)',
    { SLAYZONE_SUPERVISED: '1', SLAYZONE_HUB_REQUIRE_LOGIN: '0' },
    { login: false, processes: true }
  )
  // Loopback, so better-auth's base URL (a trusted sign-in origin) is the fixed
  // `http://127.0.0.1:8788` the sign-in below sends.
  const login = {
    SLAYZONE_HUB_REQUIRE_LOGIN: '1',
    SLAYZONE_HUB_AUTH_SECRET: SECRET
  }
  await runHub('shared hub (login on, processes on)', login, { login: true, processes: true })
  await runHub(
    'Normain hub (login on, processes off)',
    { ...login, SLAYZONE_HUB_ENABLE_PROCESSES: '0' },
    { login: true, processes: false }
  )
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
