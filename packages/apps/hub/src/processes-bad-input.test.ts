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
 * Same shape outside processes: `fileEditor.watch` with processes off and no computer
 * (its refusal floated: the hub exited), and a file named `...` under a hub-local
 * watch (the watcher's callback threw).
 *
 * Native ABI: better-sqlite3 in the hub needs Electron's node.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/processes-bad-input.test.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
const SECRET = 'processes-bad-input-test-signing-secret-0123456789'

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
  expect(res.ok, `create project: ${res.status} ${JSON.stringify(body)}`).toBe(true)
  assert(body.data?.id, `create project: ${res.status} ${JSON.stringify(body)}`)
  return body.data.id
}

type Proc = {
  mutate: (input?: unknown) => Promise<unknown>
  query: (input?: unknown) => Promise<unknown>
}
type Sub = {
  subscribe: (
    input: unknown,
    handlers: { onData?: (v: unknown) => void; onError?: (e: unknown) => void }
  ) => { unsubscribe: () => void }
}
type Client = {
  processes: Record<'create' | 'spawn' | 'update' | 'listAll', Proc>
  fileEditor: { watch: Sub }
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
  expect(
    hub.alive(),
    `hub process exited after ${after}; last lines:\n${hub.logs.slice(-15).join('\n')}`
  ).toBe(true)
  const list = await bounded(client.processes.listAll.query(), `listAll after ${after}`)
  expect(Array.isArray(list), `next request answers after ${after}`).toBe(true)
}

const LONG = 'x'.repeat(100_000)

function describeHub(
  name: string,
  env: Record<string, string>,
  opts: { login: boolean; processes: boolean }
): void {
  describe(name, () => {
    let hub: Hub
    let close = (): void => undefined
    let client: Client
    let valid: {
      projectId: string
      taskId: null
      label: string
      command: string
      cwd: string
      autoRestart: boolean
    }
    beforeAll(async () => {
      hub = await bootHub(env)
      const token = opts.login ? await signedInUser(hub) : null
      const projectId = await createProject(hub, token)
      const c = hubClient(hub, token)
      close = c.close
      client = c.client
      valid = {
        projectId,
        taskId: null,
        label: 'dev',
        command: 'echo hi',
        cwd: '/tmp',
        autoRestart: false
      }
    })
    afterAll(async () => {
      close()
      await hub?.stop()
    })
    // Without an id of the caller's, the owner gate answers before validation (T-17).
    const noOwnedId = opts.login ? 'NOT_FOUND' : 'BAD_REQUEST'

    const cases: Array<[string, () => Promise<unknown>, string]> = []
    for (const op of ['create', 'spawn'] as const) {
      const call = (input: () => unknown) => () => client.processes[op].mutate(input())
      const noLabel = (): unknown => {
        const { label: _label, ...rest } = valid
        return rest
      }
      cases.push(
        [`${op} without label`, call(noLabel), 'BAD_REQUEST'],
        [`${op} with label null`, call(() => ({ ...valid, label: null })), 'BAD_REQUEST'],
        [`${op} with an empty label`, call(() => ({ ...valid, label: '' })), 'BAD_REQUEST'],
        [`${op} with a blank label`, call(() => ({ ...valid, label: '   ' })), 'BAD_REQUEST'],
        [`${op} with an oversized label`, call(() => ({ ...valid, label: LONG })), 'BAD_REQUEST'],
        [`${op} with a number label`, call(() => ({ ...valid, label: 5 })), 'BAD_REQUEST'],
        [`${op} without command`, call(() => ({ ...valid, command: undefined })), 'BAD_REQUEST'],
        [
          `${op} with an oversized command`,
          call(() => ({ ...valid, command: LONG })),
          'BAD_REQUEST'
        ],
        [`${op} with cwd null`, call(() => ({ ...valid, cwd: null })), 'BAD_REQUEST'],
        [
          `${op} with autoRestart "yes"`,
          call(() => ({ ...valid, autoRestart: 'yes' })),
          'BAD_REQUEST'
        ],
        [`${op} with no input`, call(() => undefined), noOwnedId],
        [`${op} with input null`, call(() => null), noOwnedId],
        [`${op} with a string input`, call(() => 'garbage'), noOwnedId],
        [`${op} with an array input`, call(() => [valid]), noOwnedId]
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
      test(`${name}: ${label} → ${want}, hub stays up`, async () => {
        expect(hub.alive(), 'hub already down').toBe(true)
        const got = await codeOf(call())
        expect(got, `${label}: expected ${want}, got ${got}`).toBe(want)
        await stillUp(hub, client, label)
      })
    }

    if (opts.processes) {
      let id = ''
      test(`${name}: a valid create still works`, async () => {
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
        expect(row.label, `row as sent: ${JSON.stringify(row)}`).toBe('dev')
        expect(row.command, `row as sent: ${JSON.stringify(row)}`).toBe('echo hi')
        expect(row.cwd, `row as sent: ${JSON.stringify(row)}`).toBe('/tmp')
        expect(row.status, 'created, not spawned').toBe('stopped')
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
        test(`${name}: ${label} → BAD_REQUEST, hub stays up`, async () => {
          expect(hub.alive(), 'hub already down').toBe(true)
          const got = await codeOf(call())
          expect(got, `${label}: expected BAD_REQUEST, got ${got}`).toBe('BAD_REQUEST')
          await stillUp(hub, client, label)
        })
      }
      if (!opts.login) {
        test(`${name}: update naming a task that does not exist → INTERNAL_SERVER_ERROR, nothing changed`, async () => {
          const got = await codeOf(update({ taskId: 'no-such-task' })())
          expect(got, `expected INTERNAL_SERVER_ERROR, got ${got}`).toBe('INTERNAL_SERVER_ERROR')
          await stillUp(hub, client, 'update naming a missing task')
          const rows = (await bounded(client.processes.listAll.query(), 'listAll')) as Array<{
            id: string
            taskId: string | null
          }>
          expect(rows.find((r) => r.id === id)?.taskId, 'the refused update left the row').toBe(
            null
          )
        })
      }
      test(`${name}: a valid update still works`, async () => {
        const ok = await bounded(
          client.processes.update.mutate({
            processId: id,
            updates: { label: 'renamed', command: 'echo bye', autoRestart: true }
          }),
          'valid update'
        )
        expect(ok, 'update answers true').toBe(true)
        const rows = (await bounded(client.processes.listAll.query(), 'listAll')) as Array<{
          id: string
          label: string
          command: string
          autoRestart: boolean
        }>
        const row = rows.find((r) => r.id === id)
        assert(row, `row updated: ${JSON.stringify(row)}`)
        expect(row.label, `row updated: ${JSON.stringify(row)}`).toBe('renamed')
        expect(row.command, `row updated: ${JSON.stringify(row)}`).toBe('echo bye')
        expect(row.autoRestart, `row updated: ${JSON.stringify(row)}`).toBe(true)
      })
      // Valid input whose spawn fails after `spawn()` returned: the child reports a
      // missing cwd as an 'error' event, which nobody listened for.
      test(`${name}: spawn in a cwd that does not exist → answers, the process errors, hub stays up`, async () => {
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
        expect(
          row.logBuffer.some((l) => l.includes('failed to start')),
          `the reason is in its log: ${JSON.stringify(row.logBuffer)}`
        ).toBe(true)
      })
    } else {
      for (const op of ['create', 'spawn'] as const) {
        test(`${name}: a valid ${op} is refused by the switch, hub stays up`, async () => {
          const got = await codeOf(client.processes[op].mutate(valid))
          expect(got, `expected FORBIDDEN, got ${got}`).toBe('FORBIDDEN')
          await stillUp(hub, client, `a valid ${op}`)
        })
      }
    }

    // The same shape outside processes: `fileEditor.watch` started its watcher in a
    // floated `.then` (a refusal there was an unhandled rejection: processes off, no
    // computer), and the hub-local watcher's callback threw on a file named `...`.
    test(`${name}: fileEditor.watch ${opts.processes ? 'survives a file named "..."' : 'refusal reaches the stream'}, hub stays up`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'slz-t102-watch-'))
      const changed: string[] = []
      let error: unknown = null
      const sub = client.fileEditor.watch.subscribe(
        { rootPath: dir },
        {
          onData: (e) => changed.push((e as { relPath: string }).relPath),
          onError: (e) => {
            error = e
          }
        }
      )
      try {
        await sleep(500)
        if (opts.processes) {
          mkdirSync(join(dir, '...'))
          await sleep(300)
          writeFileSync(join(dir, 'after.txt'), 'x')
          await poll(
            async () => (changed.includes('after.txt') ? true : null),
            5_000,
            `a change after "..." (got ${JSON.stringify(changed)}, error ${String(error)})`
          )
        } else {
          await poll(async () => (error ? true : null), 5_000, 'the refusal on the stream')
          const code =
            error instanceof TRPCClientError ? (error.data as { code?: string })?.code : null
          expect(code, `refused FORBIDDEN, got ${code}`).toBe('FORBIDDEN')
        }
        await stillUp(hub, client, 'fileEditor.watch')
      } finally {
        sub.unsubscribe()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test(`${name}: the hub process is still running at the end`, async () => {
      await sleep(500)
      expect(hub.alive(), `hub exited; last lines:\n${hub.logs.slice(-15).join('\n')}`).toBe(true)
      const r = await fetch(`http://127.0.0.1:${hub.port}/health`)
      expect(r.ok, '/health answers').toBe(true)
    })
  })
}

beforeAll(() => ensureBuilt())
describeHub(
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
describeHub('shared hub (login on, processes on)', login, { login: true, processes: true })
describeHub(
  'Normain hub (login on, processes off)',
  { ...login, SLAYZONE_HUB_ENABLE_PROCESSES: '0' },
  { login: true, processes: false }
)
