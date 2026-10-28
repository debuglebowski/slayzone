/**
 * Shared harness for the side-car supervisor suites (sidecar-server-supervisor.test.ts,
 * sidecar-server-supervisor-parent-death.test.ts, sidecar-server-supervisor-real-stop.test.ts):
 * polling and process helpers, throwaway temp dirs, and the REAL built hub run under a
 * fake app (the real `startSidecarServer`) or a bare parent.
 *
 * Not a test file: no `.test.` in the name, so the runner does not collect it. Each
 * suite that makes temp dirs (startRealHub does) registers `afterAll(cleanupTmpDirs)`.
 */
import { expect } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function waitFor(cond: () => boolean, timeoutMs: number, msg: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await delay(25)
  }
  throw new Error(`timeout after ${timeoutMs}ms: ${msg}`)
}

const tmpDirs: string[] = []
export function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-sup-test-'))
  tmpDirs.push(dir)
  return dir
}

export function cleanupTmpDirs(): void {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true)
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * True once `pid` no longer runs. A zombie counts as gone: an orphan that exited
 * but has not been reaped by its new parent yet is not a running hub.
 */
export function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
    return stat.trim().startsWith('Z')
  } catch {
    return true // ps exits non-zero for a pid it cannot find
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HUB_DIR = path.resolve(HERE, '../../..', 'hub')
export const HUB_BIN = path.join(HUB_DIR, 'dist', 'bin.cjs')
/** The parent watch the hub bundles. Shared with the computer, so it lives outside hub/src. */
const PLATFORM_SRC = path.resolve(HERE, '../../../..', 'shared/platform/src')
const SUPERVISOR_MODULE = path.join(HERE, 'sidecar-server-supervisor.ts')
const QUIT_REAP_MODULE = path.join(HERE, 'lifecycle', 'quit-reap-child.ts')
/** Must cover the hub's own supervised stop deadline (5s) plus boot + reap. */
export const REAL_EXIT_BUDGET_MS = 12_000
/**
 * Written by the hub's bin.ts in the same synchronous run that installs its signal
 * handlers and its parent watch, so a hub that has printed it is fully up.
 */
const HUB_LISTENING = /\[slayzone-server\] listening on http:\/\/127\.0\.0\.1:(\d+)/

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs)
  }
  return newest
}

/** The supervisor runs dist/bin.cjs, so that is what is tested: (re)built when older than src. */
let hubBuildChecked = false
export function ensureHubBuilt(): void {
  if (hubBuildChecked) return
  const stale =
    !fs.existsSync(HUB_BIN) ||
    Math.max(newestMtime(path.join(HUB_DIR, 'src')), newestMtime(PLATFORM_SRC)) >
      fs.statSync(HUB_BIN).mtimeMs
  if (stale) {
    console.log('  … building the hub bundle (missing or older than its src)')
    execFileSync('node', ['build.mjs'], { cwd: HUB_DIR, stdio: 'inherit' })
  }
  hubBuildChecked = true
}

/**
 * Preloaded into the real hub (NODE_OPTIONS=--require). Once its app is dead
 * nothing reads the hub's stdout/stderr, so both are mirrored to a file; and the
 * exit code is recorded: 0 = a clean stop, anything else = a crash or a forced exit.
 */
const HUB_PROBE = `'use strict'
const fs = require('node:fs')
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream)
  stream.write = function (chunk, ...rest) {
    try { fs.appendFileSync(process.env.PROBE_LOG_FILE, chunk) } catch (e) {}
    return write(chunk, ...rest)
  }
}
process.on('exit', function (code) {
  try { fs.writeFileSync(process.env.PROBE_EXIT_FILE, String(code)) } catch (e) {}
})
// Observes only (does not handle): a crash's stack goes to the dead app's stderr.
process.on('uncaughtExceptionMonitor', function (err) {
  try { fs.appendFileSync(process.env.PROBE_LOG_FILE, '[probe] uncaught: ' + (err && err.stack || err) + '\\n') } catch (e) {}
})
`

/**
 * The desktop app, reduced to its supervisor: the REAL `startSidecarServer`, so the
 * hub is spawned exactly as the app spawns it. On SIGTERM it "quits" one of two ways:
 *  - FAKE_APP_QUIT=forget (default): the way the app used to — fire-and-forget
 *    `stop()`, then exit before the supervisor's SIGTERM→SIGKILL escalation lands;
 *  - FAKE_APP_QUIT=await: the way it does now — the REAL quit reap (bounded wait).
 */
const FAKE_APP = `import { startSidecarServer } from '${pathToFileURL(SUPERVISOR_MODULE).href}'
import { QUIT_CHILD_REAP_MS, reapChildForQuit } from '${pathToFileURL(QUIT_REAP_MODULE).href}'
const handle = startSidecarServer({
  execPath: process.execPath,
  scriptPath: process.env.FAKE_APP_HUB_BIN as string,
  env: JSON.parse(process.env.FAKE_APP_HUB_ENV as string),
  dbPath: 'unused',
  host: '127.0.0.1',
  logger: (line: string) => process.stdout.write(line + '\\n'),
  onReady: () => {},
  onPermanentFailure: () => {}
})
process.on('SIGTERM', () => {
  handle.suspendRestarts()
  if (process.env.FAKE_APP_QUIT === 'await') {
    void reapChildForQuit({ stop: () => handle.stop(), timeoutMs: QUIT_CHILD_REAP_MS }).then((r) => {
      process.stdout.write('[fake-app] quit: ' + r + '\\n')
      process.exit(0)
    })
    return
  }
  void handle.stop()
  setTimeout(() => process.exit(0), 500)
})
setInterval(() => {}, 1 << 30)
`

/**
 * A bare parent that spawns the hub with a chosen stdio shape — for the cases the
 * real supervisor never produces: a standalone hub logging to a file, and a stdin
 * whose other end someone else holds (FAKE_PARENT_STDIN_PORT: a socket to a server
 * in the test process), which the parent's death does not close — only the ppid
 * poll can tell.
 */
const FAKE_PARENT = `'use strict'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const out = fs.openSync(process.env.FAKE_PARENT_OUT, 'a')
function start(stdin) {
  const c = spawn(process.execPath, [process.env.FAKE_APP_HUB_BIN], {
    env: Object.assign(JSON.parse(process.env.FAKE_APP_HUB_ENV), { ELECTRON_RUN_AS_NODE: '1' }),
    stdio: [stdin, out, out]
  })
  process.stdout.write('[fake-parent] spawned pid=' + c.pid + '\\n')
}
const port = Number(process.env.FAKE_PARENT_STDIN_PORT || '0')
if (port) {
  const sock = net.connect(port, '127.0.0.1', function () { start(sock) })
} else {
  start('pipe')
}
setInterval(function () {}, 1 << 30)
`

/** A server that accepts connections and holds them open: the far end of a hub's stdin. */
async function startHoldingServer(): Promise<{ port: number; close: () => void }> {
  const sockets: net.Socket[] = []
  const server = net.createServer((s) => {
    s.on('error', () => {
      /* reset when the hub on its far end dies: expected */
    })
    sockets.push(s)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    close: () => {
      for (const s of sockets) s.destroy()
      server.close()
    }
  }
}

/**
 * A client that stays connected to the hub's `/trpc` WebSocket and never closes —
 * a `slay` subscription, a federated hub, a web-shell tab. The hub's stop closes its
 * HTTP server, whose close waits for every connection: this one keeps it waiting
 * for as long as the client lives, so the stop never finishes.
 */
async function holdHubConnection(port: number): Promise<net.Socket> {
  const socket = net.connect(port, '127.0.0.1')
  socket.on('error', () => {
    /* reset when the hub exits: expected */
  })
  let response = ''
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no WS upgrade from the hub — got: ${response}`)),
      5_000
    )
    socket.on('data', (c: Buffer) => {
      response += c.toString('latin1')
      if (response.includes('\r\n\r\n')) {
        clearTimeout(timer)
        if (response.startsWith('HTTP/1.1 101')) resolve()
        else reject(new Error(`hub refused the WS upgrade: ${response}`))
      }
    })
    socket.write(
      'GET /trpc HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n'
    )
  })
  return socket
}

/** Every SLAYZONE_ and ELECTRON_ var stripped: a supervised test runner leaks the real root. */
function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null || /^(SLAYZONE_|ELECTRON_)/.test(k) || k === 'NODE_OPTIONS') continue
    out[k] = v
  }
  return out
}

export type RealHubRun = {
  /** The process the hub believes is its app. */
  parent: ChildProcess
  hubPid: number
  hubPort: number
  /** The parent's own output so far. */
  parentOutput: () => string
  /** The hub's stdout + stderr so far (mirrored by the probe). */
  log: () => string
  /** The hub's exit code, once it has exited on its own (null otherwise). */
  exitCode: () => string | null
  /** Open a `/trpc` client connection to the hub and hold it until cleanup. */
  holdConnection: () => Promise<void>
  /** Close every connection {@link holdConnection} opened. */
  releaseConnections: () => void
  cleanup: () => void
}

export async function startRealHub(opts: {
  parent: 'supervisor' | 'stdin-held-elsewhere' | 'standalone'
  supervised: boolean
  /** FAKE_APP_QUIT for a 'supervisor' parent. */
  quit?: 'forget' | 'await'
}): Promise<RealHubRun> {
  ensureHubBuilt()
  const dir = mkTmp()
  fs.mkdirSync(path.join(dir, 'home'))
  fs.mkdirSync(path.join(dir, 'root'))
  const probe = path.join(dir, 'probe.cjs')
  fs.writeFileSync(probe, HUB_PROBE)
  const logFile = path.join(dir, 'hub.log')
  const exitFile = path.join(dir, 'hub.exit')
  const stdinHolder = opts.parent === 'stdin-held-elsewhere' ? await startHoldingServer() : null
  const hubEnv: Record<string, string> = {
    ...scrubbedEnv(),
    // Isolated: the hub's DB, logs and state all live in `dir`.
    HOME: path.join(dir, 'home'),
    SLAYZONE_ROOT: path.join(dir, 'root'),
    SLAYZONE_NONINTERACTIVE: '1',
    // What the supervisor sets for a supervised hub; a bare parent sets it here.
    ...(opts.parent === 'supervisor'
      ? {}
      : {
          SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
          ...(opts.supervised
            ? { SLAYZONE_SUPERVISED: '1', SLAYZONE_HUB_REQUIRE_LOGIN: '0' }
            : { SLAYZONE_HUB_AUTH_SECRET: 'parent-death-test-secret-at-least-32-chars' })
        }),
    NODE_OPTIONS: `--require ${probe}`,
    PROBE_LOG_FILE: logFile,
    PROBE_EXIT_FILE: exitFile
  }
  const parentEnv: Record<string, string> = {
    ...scrubbedEnv(),
    ELECTRON_RUN_AS_NODE: '1',
    FAKE_APP_HUB_BIN: HUB_BIN,
    FAKE_APP_HUB_ENV: JSON.stringify(hubEnv)
  }
  let parent: ChildProcess
  if (opts.parent === 'supervisor') {
    const script = path.join(dir, 'fake-app.mts')
    fs.writeFileSync(script, FAKE_APP)
    parent = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), script], {
      env: { ...parentEnv, FAKE_APP_QUIT: opts.quit ?? 'forget' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } else {
    const script = path.join(dir, 'fake-parent.cjs')
    fs.writeFileSync(script, FAKE_PARENT)
    parent = spawn(process.execPath, [script], {
      env: {
        ...parentEnv,
        FAKE_PARENT_OUT: path.join(dir, 'hub.out'),
        ...(stdinHolder ? { FAKE_PARENT_STDIN_PORT: String(stdinHolder.port) } : {})
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
  }
  let parentOut = ''
  parent.stdout?.on('data', (c: Buffer) => (parentOut += c.toString()))
  parent.stderr?.on('data', (c: Buffer) => (parentOut += c.toString()))

  const read = (file: string): string => {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }
  let hubPid = 0
  const held: net.Socket[] = []
  const cleanup = (): void => {
    for (const pid of [hubPid, parent.pid]) {
      if (pid && !pidGone(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
    }
    for (const s of held) s.destroy()
    parent.stdin?.destroy()
    stdinHolder?.close()
  }
  try {
    await waitFor(
      () => /spawned pid=\d+/.test(parentOut),
      20_000,
      `parent never spawned the hub — output: ${parentOut}`
    )
    hubPid = Number(/spawned pid=(\d+)/.exec(parentOut)![1])
    await waitFor(
      () => HUB_LISTENING.test(read(logFile)),
      30_000,
      `hub never booted — log: ${read(logFile)} ${read(path.join(dir, 'hub.out'))} parent: ${parentOut}`
    )
    // Under the supervisor, also wait until it has seen the hub ready, as an app
    // quit would: until then its `/health` probe may be in flight, and the hub's
    // stop (its HTTP server close) can wait on that connection past the
    // supervisor's SIGTERM grace.
    if (opts.parent === 'supervisor') {
      await waitFor(
        () => parentOut.includes('[supervisor] sidecar ready'),
        20_000,
        `the supervisor never saw the hub ready — parent: ${parentOut}`
      )
    }
  } catch (err) {
    cleanup()
    throw err
  }
  const hubPort = Number(HUB_LISTENING.exec(read(logFile))![1])
  return {
    parent,
    hubPid,
    hubPort,
    parentOutput: () => parentOut,
    log: () => read(logFile),
    exitCode: () => (fs.existsSync(exitFile) ? read(exitFile) : null),
    holdConnection: async () => {
      held.push(await holdHubConnection(hubPort))
    },
    releaseConnections: () => {
      for (const s of held.splice(0)) s.destroy()
    },
    cleanup
  }
}

/** {@link waitFor}, but a timeout carries the hub's log as it is THEN. */
export async function waitForRun(
  run: RealHubRun,
  cond: () => boolean,
  timeoutMs: number,
  msg: string
): Promise<void> {
  await waitFor(cond, timeoutMs, msg).catch((err: unknown) => {
    throw new Error(`${err instanceof Error ? err.message : String(err)} — log:\n${run.log()}`)
  })
}

/** The hub's stop hung, and its own supervised deadline is what ended it. */
export function assertStoppedByItsDeadline(run: RealHubRun): void {
  expect(run.log(), `the hub forced its own exit — log:\n${run.log()}`).toContain('forcing exit')
  expect(run.exitCode(), `a forced exit reports failure — log:\n${run.log()}`).toBe('1')
}
