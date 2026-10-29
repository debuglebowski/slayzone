/**
 * Which hub a command goes to when this machine has a STORED hub target
 * (`slay hub use` / `slay hub login`, `~/.slayzone/cli/hub-target[.dev].json`).
 *
 * The bug this pins (2026-10-29): `slay hub login <remote>` silently retargeted every
 * `slay` on the machine, including the agent toolbox inside the local app's task
 * terminals — `slay tasks view $SLAYZONE_TASK_ID` went to the remote hub, with the
 * remote bearer, and answered "Not found". The rules now:
 *   - TASK commands in a task terminal (`SLAYZONE_TASK_ID` set) go to the app that
 *     spawned it, never to the stored target; with no word of which app that is,
 *     they refuse rather than guess.
 *   - HUB commands (`hub users`, `hub computers`, `computer mint`) use the stored
 *     target, in a task terminal too.
 *   - a plain shell behaves as before: the stored target is the target.
 *   - break-glass keeps its session apart and never touches the stored target.
 *
 * HOME points at a temp dir for every test: the stored target lives under
 * `$HOME/.slayzone/cli`, and this file must never read or clobber the real one.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/cli/test/hub-target-scope.test.ts
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'
import { captureAllAsync } from './test-harness.js'
import {
  getBreakGlassSessionPath,
  getHubConfigPath,
  resolveHubCommandTarget,
  resolveTaskCommandTarget,
  writeBreakGlassSession,
  writeHubConfig
} from '../src/hub-config'
import { apiGet } from '../src/api'
import { hubBreakGlassCommand } from '../src/commands/hub-break-glass'
import { hubCommand } from '../src/commands/hub'

// --- env + fs scaffolding -------------------------------------------------

const ENV_KEYS = [
  'HOME',
  'SLAYZONE_TASK_ID',
  'SLAYZONE_HUB_ADDRESS',
  'SLAYZONE_HUB_TOKEN',
  'SLAYZONE_ROOT',
  'SLAYZONE_DEV'
] as const
type EnvKey = (typeof ENV_KEYS)[number]

const savedEnv: Partial<Record<EnvKey, string>> = {}
for (const k of ENV_KEYS) {
  if (process.env[k] !== undefined) savedEnv[k] = process.env[k]
}

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-hub-scope-'))
  tmpDirs.push(dir)
  return dir
}

/** A fresh HOME + nothing else hub-related; `vars` on top. */
function setEnv(vars: Partial<Record<Exclude<EnvKey, 'HOME'>, string>> = {}): void {
  for (const k of ENV_KEYS) delete process.env[k]
  process.env.HOME = home
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) process.env[k] = v
  }
}

interface SeenRequest {
  method: string
  url: string
  auth: string | null
}

interface TestServer {
  port: number
  url: string
  seen: SeenRequest[]
  close: () => Promise<void>
}

/** A hub stand-in: records every request, answers `respond(req)` (default `{ok:true}`). */
function startServer(
  respond: (req: http.IncomingMessage) => { status?: number; body: unknown } = () => ({
    body: { ok: true }
  })
): Promise<TestServer> {
  return new Promise((resolve) => {
    const seen: SeenRequest[] = []
    const server = http.createServer((req, res) => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization ?? null
      })
      req.resume()
      req.on('end', () => {
        const { status, body } = respond(req)
        res.statusCode = status ?? 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise<void>((r) => server.close(() => r()))
      })
    })
  })
}

let home: string
// `app` = the desktop app that spawned the task terminal; `remote` = the hub the CLI
// signed in to. Both are loopback stand-ins: what matters is which one is reached.
let app: TestServer
let remote: TestServer

beforeEach(async () => {
  home = tmpDir()
  app = await startServer()
  remote = await startServer()
  setEnv()
})

afterEach(async () => {
  await app.close()
  await remote.close()
})

/** The `slay hub login` outcome: the remote hub, stored with its bearer. */
function signInToRemote(): void {
  writeHubConfig(remote.url, 'remote-token')
}

/** Run `slay hub <args…>` in-process. */
async function runHub(...args: string[]) {
  return captureAllAsync(async () => {
    await hubCommand().parseAsync(args, { from: 'user' })
  })
}

// --- task terminal --------------------------------------------------------

describe('task terminal (SLAYZONE_TASK_ID set)', () => {
  test('task commands go to the app that spawned it, never to the stored remote target', async () => {
    signInToRemote()
    setEnv({
      SLAYZONE_TASK_ID: 'task-1',
      SLAYZONE_ROOT: tmpDir(),
      SLAYZONE_HUB_ADDRESS: `127.0.0.1:${app.port}`
    })
    await apiGet('/api/tasks/task-1')
    expect(app.seen.map((r) => r.url)).toEqual(['/api/tasks/task-1'])
    // The remote hub hears nothing — and its bearer never reaches the app either.
    expect(remote.seen).toHaveLength(0)
    expect(app.seen[0].auth).toBeNull()
  })

  test('with no SLAYZONE_HUB_ADDRESS the stored target is still not used: the local app is', () => {
    signInToRemote()
    setEnv({ SLAYZONE_TASK_ID: 'task-1', SLAYZONE_ROOT: tmpDir() })
    // null = "the local app", found by probing its fixed port and checking that the
    // responder serves THIS terminal's SLAYZONE_ROOT (local-hub.ts).
    expect(resolveTaskCommandTarget()).toBeNull()
  })

  test('with neither SLAYZONE_HUB_ADDRESS nor SLAYZONE_ROOT it refuses and sends nothing', async () => {
    signInToRemote()
    setEnv({ SLAYZONE_TASK_ID: 'task-1' })
    const { exitCode, stderr } = await captureAllAsync(async () => {
      await apiGet('/api/tasks/task-1')
    })
    expect(exitCode).toBe(1)
    expect(stderr.join('\n')).toMatch(/does not say which app/)
    expect(remote.seen).toHaveLength(0)
  })

  test('the stored bearer rides along only when the stored target IS the spawning hub', async () => {
    // A cloud computer: `slay hub login <its hub>` once, then every task terminal the
    // computer opens for that hub carries the same address.
    writeHubConfig(app.url, 'same-hub-token')
    setEnv({
      SLAYZONE_TASK_ID: 'task-1',
      SLAYZONE_ROOT: tmpDir(),
      SLAYZONE_HUB_ADDRESS: `127.0.0.1:${app.port}`
    })
    await apiGet('/api/tasks/task-1')
    expect(app.seen[0].auth).toBe('Bearer same-hub-token')
  })

  test('hub commands use the stored target', () => {
    signInToRemote()
    setEnv({
      SLAYZONE_TASK_ID: 'task-1',
      SLAYZONE_ROOT: tmpDir(),
      SLAYZONE_HUB_ADDRESS: `127.0.0.1:${app.port}`
    })
    expect(resolveHubCommandTarget()).toMatchObject({
      baseUrl: remote.url,
      token: 'remote-token',
      source: 'file'
    })
  })

  test('hub commands fall back to the spawning app when nothing is stored', () => {
    setEnv({
      SLAYZONE_TASK_ID: 'task-1',
      SLAYZONE_ROOT: tmpDir(),
      SLAYZONE_HUB_ADDRESS: `127.0.0.1:${app.port}`
    })
    expect(resolveHubCommandTarget()).toMatchObject({ baseUrl: app.url, source: 'env' })
  })

  test('`hub current` names both targets and where each comes from', async () => {
    signInToRemote()
    setEnv({
      SLAYZONE_TASK_ID: 'task-1',
      SLAYZONE_ROOT: tmpDir(),
      SLAYZONE_HUB_ADDRESS: `127.0.0.1:${app.port}`
    })
    const { stdout, exitCode } = await runHub('current')
    const out = stdout.join('\n')
    expect(exitCode).toBeNull()
    const [taskBlock, hubBlock] = out.split(/^Hub commands/m)
    expect(taskBlock).toMatch(/^Task commands/m)
    expect(taskBlock).toContain(app.url)
    expect(taskBlock).toContain('SLAYZONE_HUB_ADDRESS')
    expect(hubBlock).toContain(remote.url)
    expect(hubBlock).toContain(getHubConfigPath())
    expect(out.match(/Health: ok/g)).toHaveLength(2)
  })
})

// --- plain shell ----------------------------------------------------------

describe('plain shell (no SLAYZONE_TASK_ID)', () => {
  test('task commands follow the stored target, with its bearer', async () => {
    signInToRemote()
    await apiGet('/api/tasks')
    expect(remote.seen).toEqual([{ method: 'GET', url: '/api/tasks', auth: 'Bearer remote-token' }])
    expect(app.seen).toHaveLength(0)
  })

  test('SLAYZONE_HUB_ADDRESS set by hand still beats the stored target, for every command', () => {
    signInToRemote()
    setEnv({ SLAYZONE_HUB_ADDRESS: `127.0.0.1:${app.port}` })
    expect(resolveTaskCommandTarget()).toMatchObject({ baseUrl: app.url, source: 'env' })
    expect(resolveHubCommandTarget()).toMatchObject({ baseUrl: app.url, source: 'env' })
  })
})

// --- break-glass ----------------------------------------------------------

describe('break-glass', () => {
  const FUTURE = () => new Date(Date.now() + 30 * 60_000).toISOString()

  /** Run `slay hub break-glass <args…>` in-process, with `stdin` lines fed to it. */
  async function runBreakGlass(args: string[], stdinLines: string[] = []) {
    const stdin = new PassThrough()
    const original = Object.getOwnPropertyDescriptor(process, 'stdin')!
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (() => true) as typeof process.stdout.write
    try {
      for (const line of stdinLines) stdin.write(`${line}\n`)
      return await captureAllAsync(async () => {
        await hubBreakGlassCommand().parseAsync(args, { from: 'user' })
      })
    } finally {
      process.stdout.write = origWrite
      Object.defineProperty(process, 'stdin', original)
    }
  }

  test('start/end leave an existing hub target untouched', async () => {
    const hub = await startServer((req) =>
      req.method === 'POST'
        ? { body: { token: 'szbg_session', expiresAt: FUTURE(), email: 'bg@hub' } }
        : { body: { ok: true } }
    )
    try {
      signInToRemote()
      const stored = fs.readFileSync(getHubConfigPath(), 'utf8')

      const started = await runBreakGlass(['start', hub.url], [''])
      expect(started.exitCode).toBeNull()
      expect(fs.readFileSync(getHubConfigPath(), 'utf8')).toBe(stored)
      expect(fs.statSync(getBreakGlassSessionPath()).mode & 0o777).toBe(0o600)
      // Hub commands use the session while it lasts; task commands never do.
      expect(resolveHubCommandTarget()).toMatchObject({
        baseUrl: hub.url,
        token: 'szbg_session',
        source: 'break-glass'
      })
      expect(resolveTaskCommandTarget()).toMatchObject({ baseUrl: remote.url, source: 'file' })

      const ended = await runBreakGlass(['end'])
      expect(ended.exitCode).toBeNull()
      expect(hub.seen.at(-1)).toMatchObject({ method: 'DELETE', auth: 'Bearer szbg_session' })
      expect(fs.existsSync(getBreakGlassSessionPath())).toBe(false)
      expect(fs.readFileSync(getHubConfigPath(), 'utf8')).toBe(stored)
      expect(resolveHubCommandTarget()).toMatchObject({ baseUrl: remote.url, source: 'file' })
    } finally {
      await hub.close()
    }
  })

  test('an expired session is ignored', () => {
    signInToRemote()
    writeBreakGlassSession({
      url: app.url,
      token: 'szbg_old',
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    })
    expect(resolveHubCommandTarget()).toMatchObject({ baseUrl: remote.url, source: 'file' })
  })

  test('end forgets a session the hub already ended (401)', async () => {
    const hub = await startServer(() => ({ status: 401, body: { error: 'Unauthorized' } }))
    try {
      writeBreakGlassSession({ url: hub.url, token: 'szbg_gone', expiresAt: FUTURE() })
      const ended = await runBreakGlass(['end'])
      expect(ended.exitCode).toBeNull()
      expect(fs.existsSync(getBreakGlassSessionPath())).toBe(false)
    } finally {
      await hub.close()
    }
  })

  test('end still ends a session an older CLI stored as the hub target', async () => {
    const hub = await startServer()
    try {
      writeHubConfig(hub.url, 'szbg_legacy')
      const ended = await runBreakGlass(['end'])
      expect(ended.exitCode).toBeNull()
      expect(hub.seen.at(-1)).toMatchObject({ method: 'DELETE', auth: 'Bearer szbg_legacy' })
      expect(fs.existsSync(getHubConfigPath())).toBe(false)
    } finally {
      await hub.close()
    }
  })
})

// --- teardown ---------------------------------------------------------------

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
