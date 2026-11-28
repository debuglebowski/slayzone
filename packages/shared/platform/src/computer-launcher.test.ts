import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ensureComputerLauncher } from './computer-launcher'
import { PRE_LOCK_COMPUTER_LAUNCHER } from './computer-launcher.pre-lock.fixture'
import {
  HOST_SUPERSEDED_EXIT_CODE,
  HOST_SUPERSEDED_NOTICE,
  HostLauncherBusyError,
  LEGACY_HOST_SUPERSEDED_EXIT_CODE,
  hostEndpointDir,
  hostLauncherEndpoint,
  prepareEndpointDir,
  queryHostLauncher
} from './computer-endpoints'

it('stable launcher rolls back supervisor that fails before readiness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'computer-launcher-'))
  const good = join(root, 'good.cjs'),
    bad = join(root, 'bad.cjs')
  writeFileSync(good, "process.send({type:'supervisor-ready'},()=>process.disconnect())")
  writeFileSync(bad, 'process.exit(1)')
  const launcher = ensureComputerLauncher(root, { version: '1', entry: good })
  const pointer = join(root, 'computer-runtime', 'supervisor.json')
  writeFileSync(
    pointer,
    JSON.stringify({
      current: { version: '2', entry: bad },
      previous: { version: '1', entry: good }
    })
  )
  try {
    await new Promise<void>((resolve, reject) =>
      execFile(
        process.execPath,
        [launcher],
        { env: { ...process.env, SLAYZONE_ROOT: root }, timeout: 10_000 },
        (err) => (err ? reject(err) : resolve())
      )
    )
    expect(JSON.parse(readFileSync(pointer, 'utf8')).current.entry).toBe(good)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('rolls back a supervisor that crashes immediately after announcing readiness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'computer-launcher-probation-'))
  const good = join(root, 'good.cjs'),
    bad = join(root, 'bad.cjs')
  writeFileSync(good, "process.send({type:'supervisor-ready'},()=>process.disconnect())")
  writeFileSync(bad, "process.send({type:'supervisor-ready'},()=>process.exit(1))")
  const launcher = ensureComputerLauncher(root, { version: '1', entry: good })
  const pointer = join(root, 'computer-runtime', 'supervisor.json')
  writeFileSync(
    pointer,
    JSON.stringify({
      current: { version: '2', entry: bad },
      previous: { version: '1', entry: good }
    })
  )
  try {
    await new Promise<void>((resolve, reject) =>
      execFile(
        process.execPath,
        [launcher],
        { env: { ...process.env, SLAYZONE_ROOT: root }, timeout: 6000 },
        (err) => (err ? reject(err) : resolve())
      )
    )
    expect(JSON.parse(readFileSync(pointer, 'utf8')).current.version).toBe('1')
    expect(
      JSON.parse(readFileSync(join(root, 'computer-runtime', 'supervisor-quarantine.json'), 'utf8'))
        .version
    ).toBe('2')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 10_000)

it('startup watchdog treats a slow supervisor as a crash, preserving host work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'computer-watchdog-'))
  const good = join(root, 'good.cjs'),
    bad = join(root, 'bad.cjs')
  const teardown = join(root, 'host-was-stopped')
  writeFileSync(good, "process.send({type:'supervisor-ready'},()=>process.disconnect())")
  writeFileSync(
    bad,
    `process.on('SIGTERM',()=>{require('node:fs').writeFileSync(${JSON.stringify(teardown)},'killed');process.exit(0)});setInterval(()=>{},1000)`
  )
  const launcher = ensureComputerLauncher(root, { entry: good, version: '1' })
  const pointer = join(root, 'computer-runtime', 'supervisor.json')
  writeFileSync(
    pointer,
    JSON.stringify({
      current: { entry: bad, version: '2' },
      previous: { entry: good, version: '1' }
    })
  )
  writeFileSync(
    launcher,
    readFileSync(launcher, 'utf8')
      .replace('}, 90000);', '}, 300);')
      .replace('BACKOFF_MIN_MS = 2000', 'BACKOFF_MIN_MS = 10')
  )
  try {
    const stderr = await new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        [launcher],
        { env: { ...process.env, SLAYZONE_ROOT: root }, timeout: 3000 },
        (err, _stdout, stderr) => (err ? reject(err) : resolve(stderr))
      )
    )
    expect(stderr).toContain('supervisor 2 startup timed out; restarting')
    expect(JSON.parse(readFileSync(pointer, 'utf8')).current.version).toBe('1')
    const { existsSync } = await import('node:fs')
    expect(existsSync(teardown)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('host startup watchdog retries after timeout and permits POSIX cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'computer-host-watchdog-'))
  const good = join(root, 'good.cjs'),
    bad = join(root, 'bad.cjs')
  const cleaned = join(root, 'host-cleaned')
  writeFileSync(good, "process.send({type:'supervisor-ready'},()=>process.disconnect())")
  writeFileSync(
    bad,
    `process.on('SIGTERM',()=>{require('node:fs').writeFileSync(${JSON.stringify(cleaned)},'yes');process.exit(0)});setInterval(()=>{},1000)`
  )
  const launcher = ensureComputerLauncher(root, { entry: good, version: '1' })
  const pointer = join(root, 'computer-runtime', 'host-release.json')
  writeFileSync(
    pointer,
    JSON.stringify({
      current: { entry: bad, version: '2' },
      previous: { entry: good, version: '1' }
    })
  )
  writeFileSync(
    launcher,
    readFileSync(launcher, 'utf8')
      .replace('}, 90000);', '}, 300);')
      .replace('BACKOFF_MIN_MS = 2000', 'BACKOFF_MIN_MS = 10')
  )
  try {
    await new Promise<void>((resolve, reject) =>
      execFile(
        process.execPath,
        [launcher, '--session-host'],
        { env: { ...process.env, SLAYZONE_ROOT: root }, timeout: 3000 },
        (err) => (err ? reject(err) : resolve())
      )
    )
    // Node terminates forcibly on Windows; SIGTERM handlers only run on POSIX.
    if (process.platform !== 'win32') expect(readFileSync(cleaned, 'utf8')).toBe('yes')
    expect(JSON.parse(readFileSync(pointer, 'utf8')).current.version).toBe('1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('explicit stop during crash backoff does not start another child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'computer-backoff-stop-'))
  const bad = join(root, 'bad.cjs'),
    boots = join(root, 'boots')
  writeFileSync(
    bad,
    `require('node:fs').appendFileSync(${JSON.stringify(boots)},'boot\\n');process.exit(1)`
  )
  const launcher = ensureComputerLauncher(root, { entry: bad, version: '1' })
  writeFileSync(
    launcher,
    readFileSync(launcher, 'utf8').replace(
      "child.on('exit', (code, signal) => {",
      "child.on('exit', (code, signal) => {process.stdout.write('child-exited\\n');"
    )
  )
  const child = spawn(process.execPath, [launcher], {
    env: { ...process.env, SLAYZONE_ROOT: root },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
  try {
    await once(child.stdout, 'data')
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
    expect(readFileSync(boots, 'utf8').trim().split('\n')).toEqual(['boot'])
  } finally {
    clearTimeout(deadline)
    child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
}, 10000)

const computerLog = (root: string): string => {
  try {
    return readFileSync(join(root, 'logs', 'computer.log'), 'utf8')
  } catch {
    return ''
  }
}

it('logs every child exit (code, signal, uptime) to computer.log, with a growing restart delay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'computer-launcher-log-'))
  const bad = join(root, 'bad.cjs')
  writeFileSync(bad, 'process.exit(3)')
  const launcher = ensureComputerLauncher(root, { entry: bad, version: '7' })
  writeFileSync(
    launcher,
    readFileSync(launcher, 'utf8').replace('BACKOFF_MIN_MS = 2000', 'BACKOFF_MIN_MS = 50')
  )
  const child = spawn(process.execPath, [launcher], {
    env: { ...process.env, SLAYZONE_ROOT: root },
    stdio: 'ignore'
  })
  try {
    for (let i = 0; i < 100 && (computerLog(root).match(/restarting in/g) ?? []).length < 3; i++)
      await new Promise((r) => setTimeout(r, 50))
    const log = computerLog(root)
    expect(log).toMatch(
      /^\S+ \[launcher \d+\] supervisor 7 started pid=\d+\n\S+ \[launcher \d+\] supervisor 7 pid=\d+ exited code=3 signal=null after \d+ms; restarting in 50ms \(failure 1\)\n/
    )
    expect(log).toContain('restarting in 100ms (failure 2)')
    expect(log).toContain('restarting in 200ms (failure 3)')
    expect(log).toContain('started pid=')
    expect(log).toContain('(after 2 consecutive failures)')
  } finally {
    child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
}, 10_000)

// Windows has no signals: a "SIGKILL" there is TerminateProcess, seen as code=1 signal=null.
it.skipIf(process.platform === 'win32')(
  'logs a child killed by a signal (the OOM killer SIGKILLs) and the rollback it caused',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'computer-launcher-signal-'))
    const good = join(root, 'good.cjs'),
      bad = join(root, 'bad.cjs')
    writeFileSync(good, "process.send({type:'supervisor-ready'},()=>process.disconnect())")
    writeFileSync(bad, "process.kill(process.pid, 'SIGKILL')")
    const launcher = ensureComputerLauncher(root, { version: '1', entry: good })
    writeFileSync(
      join(root, 'computer-runtime', 'supervisor.json'),
      JSON.stringify({
        current: { version: '2', entry: bad },
        previous: { version: '1', entry: good }
      })
    )
    writeFileSync(
      launcher,
      readFileSync(launcher, 'utf8').replace('BACKOFF_MIN_MS = 2000', 'BACKOFF_MIN_MS = 10')
    )
    try {
      await new Promise<void>((resolve, reject) =>
        execFile(
          process.execPath,
          [launcher],
          { env: { ...process.env, SLAYZONE_ROOT: root }, timeout: 5000 },
          (err) => (err ? reject(err) : resolve())
        )
      )
      const log = computerLog(root)
      expect(log).toMatch(
        /supervisor 2 pid=\d+ exited code=null signal=SIGKILL after \d+ms; quarantined, rolled back to 1; restarting in 10ms \(failure 1\)/
      )
      expect(log).toMatch(
        /supervisor 1 pid=\d+ exited code=0 signal=null after \d+ms; not restarting/
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  10_000
)

it.skipIf(process.platform === 'win32')(
  'the session host launcher keeps its host.log bounded: copied to .1, truncated in place',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'computer-launcher-hostlog-'))
    const runtime = join(root, 'computer-runtime')
    mkdirSync(runtime, { recursive: true })
    const hostLog = join(runtime, 'host.log')
    writeFileSync(hostLog, 'old line\n'.repeat(200))
    const good = join(root, 'good.cjs')
    writeFileSync(good, "process.send({type:'supervisor-ready'},()=>process.disconnect())")
    const launcher = ensureComputerLauncher(root, {
      entry: good,
      version: '1'
    })
    writeFileSync(
      launcher,
      readFileSync(launcher, 'utf8').replace(
        'LOG_MAX_BYTES = 5 * 1024 * 1024',
        'LOG_MAX_BYTES = 1000'
      )
    )
    // Started the way ensureSessionHost starts it: stdout/stderr appending to host.log.
    const out = openSync(hostLog, 'a')
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [launcher, '--session-host'], {
          env: { ...process.env, SLAYZONE_ROOT: root },
          stdio: ['ignore', out, out]
        })
        child.on('error', reject)
        child.on('exit', () => resolve())
      })
      expect(readFileSync(`${hostLog}.1`, 'utf8')).toContain('old line')
      const now = readFileSync(hostLog, 'utf8')
      expect(now).not.toContain('old line')
      // Kept writing to the same file, at its new start.
      expect(now).toMatch(/^\S+ \[launcher \d+\] host 1 started pid=/)
      expect(existsSync(hostLog)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  10_000
)

// ── One session-host launcher per computer root ─────────────────────────────────
// 2026-11-22: two launchers ran for one root; every child of the second died with
// EADDRINUSE and was restarted (and rolled back) forever.

/** A host entry that records each boot and then stays up (or runs `then`). */
function hostEntry(
  root: string,
  then = 'setInterval(()=>{},1000)'
): {
  entry: string
  boots: () => number[]
} {
  const entry = join(root, 'host.cjs'),
    file = join(root, 'boots')
  writeFileSync(
    entry,
    `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(file)},process.pid+'\\n');` +
      `const n=fs.readFileSync(${JSON.stringify(file)},'utf8').trim().split('\\n').length;` +
      `process.on('SIGTERM',()=>process.exit(0));${then}`
  )
  return {
    entry,
    boots: () => {
      try {
        return readFileSync(file, 'utf8').trim().split('\n').map(Number)
      } catch {
        return []
      }
    }
  }
}
function hostLauncher(root: string): ChildProcess {
  return spawn(process.execPath, [join(root, 'computer-runtime', 'launch.cjs'), '--session-host'], {
    env: { ...process.env, SLAYZONE_ROOT: root },
    stdio: 'ignore'
  })
}
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached in time')
    await new Promise((r) => setTimeout(r, 25))
  }
}
function exitOf(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return once(child, 'exit').then(([code]) => code as number | null)
}
function launcherRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  launcherCleanup.push(() => {
    const dir = hostEndpointDir(root)
    if (dir) rmSync(dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
  return root
}
const launcherCleanup: (() => void)[] = []
const launcherProcs: ChildProcess[] = []
const killPids: number[] = []
afterEach(() => {
  for (const p of launcherProcs.splice(0)) p.kill('SIGKILL')
  for (const pid of killPids.splice(0))
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* Gone. */
    }
  for (const fn of launcherCleanup.splice(0)) fn()
})
function track(child: ChildProcess): ChildProcess {
  launcherProcs.push(child)
  return child
}

// Windows: SIGTERM is TerminateProcess, so the first launcher cannot exit 0 on it.
it.skipIf(process.platform === 'win32')(
  'a second host launcher for the same root exits superseded and starts no child',
  async () => {
    const root = launcherRoot('launcher-single-')
    const host = hostEntry(root)
    ensureComputerLauncher(root, { entry: host.entry, version: '1' })
    const first = track(hostLauncher(root))
    await until(() => host.boots().length === 1)
    killPids.push(...host.boots())
    const second = track(hostLauncher(root))
    expect(await exitOf(second)).toBe(0)
    await new Promise((r) => setTimeout(r, 200))
    expect(host.boots()).toHaveLength(1)
    expect(computerLog(root)).toMatch(
      /host launcher already running for this root; superseded, stopping/
    )
    // The live one is untouched, and its endpoint answers.
    expect(first.exitCode).toBeNull()
    expect((await queryHostLauncher(root, 'status'))?.state).toBe('running')
    first.kill('SIGTERM')
    expect(await exitOf(first)).toBe(0)
    const dir = hostEndpointDir(root)
    if (dir) expect(existsSync(dir)).toBe(false)
  },
  15_000
)

it('five host launchers started at once: exactly one ever starts a child', async () => {
  const root = launcherRoot('launcher-race-')
  const host = hostEntry(root)
  ensureComputerLauncher(root, { entry: host.entry, version: '1' })
  const all = Array.from({ length: 5 }, () => track(hostLauncher(root)))
  await until(() => all.filter((c) => c.exitCode !== null).length === 4, 10_000)
  await new Promise((r) => setTimeout(r, 300))
  killPids.push(...host.boots())
  expect(host.boots()).toHaveLength(1)
  for (const c of all.filter((c) => c.exitCode !== null)) expect(c.exitCode).toBe(0)
}, 20_000)

// listen() is bind() then listen(): between them the socket file refuses connections,
// exactly like a dead launcher's. 2026-11-27: under full CPU load a launcher probed a
// winner preempted in that gap and "took over" its live endpoint — two hosts ran. So
// every bind happens while holding the guard, and a launcher never binds without it.
it.skipIf(process.platform === 'win32')(
  'a host launcher binds only while holding the bind guard, and waits for it',
  async () => {
    const root = launcherRoot('launcher-guard-')
    const host = hostEntry(root)
    ensureComputerLauncher(root, { entry: host.entry, version: '1' })
    prepareEndpointDir(hostEndpointDir(root)!)
    const guard = `${hostLauncherEndpoint(root)}.takeover`
    mkdirSync(guard, { mode: 0o700 })
    const launcher = track(hostLauncher(root))
    // Longer than 50 retries at the guard's poll interval: waiting is not failing.
    await new Promise((r) => setTimeout(r, 2000))
    expect(existsSync(hostLauncherEndpoint(root))).toBe(false)
    expect(host.boots()).toHaveLength(0)
    expect(launcher.exitCode).toBeNull()
    rmSync(guard, { recursive: true })
    await until(() => host.boots().length === 1)
    killPids.push(...host.boots())
    expect(existsSync(guard)).toBe(false)
    expect((await queryHostLauncher(root, 'status'))?.state).toBe('running')
  },
  15_000
)

it.skipIf(process.platform === 'win32')(
  'a launcher endpoint left by a SIGKILLed launcher is taken over',
  async () => {
    const root = launcherRoot('launcher-stale-')
    const host = hostEntry(root)
    ensureComputerLauncher(root, { entry: host.entry, version: '1' })
    const first = track(hostLauncher(root))
    await until(() => host.boots().length === 1)
    first.kill('SIGKILL')
    await exitOf(first)
    process.kill(host.boots()[0], 'SIGKILL')
    expect(existsSync(hostLauncherEndpoint(root))).toBe(true)
    const second = track(hostLauncher(root))
    await until(() => host.boots().length === 2)
    killPids.push(...host.boots())
    expect(second.exitCode).toBeNull()
    expect((await queryHostLauncher(root, 'status'))?.state).toBe('running')
  },
  15_000
)

/** What a superseded session host does (cli-main.ts): the notice over IPC, then its exit code. */
const SUPERSEDED_HOST = `process.send({type:${JSON.stringify(HOST_SUPERSEDED_NOTICE)}},()=>process.exit(${HOST_SUPERSEDED_EXIT_CODE}))`

it.each([
  ['current', SUPERSEDED_HOST, HOST_SUPERSEDED_EXIT_CODE],
  ['0.44.0', `process.exit(${LEGACY_HOST_SUPERSEDED_EXIT_CODE})`, LEGACY_HOST_SUPERSEDED_EXIT_CODE]
])(
  'a %s child exiting superseded stops its launcher: exit 0, no restart, no quarantine, no rollback',
  async (_, superseded, code) => {
    const root = launcherRoot('launcher-superseded-')
    const host = hostEntry(root, superseded)
    const good = join(root, 'good.cjs')
    writeFileSync(good, 'setInterval(()=>{},1000)')
    ensureComputerLauncher(root, { entry: good, version: '1' })
    const pointer = join(root, 'computer-runtime', 'host-release.json')
    writeFileSync(
      pointer,
      JSON.stringify({
        current: { entry: host.entry, version: '2' },
        previous: { entry: good, version: '1' }
      })
    )
    const launcher = track(hostLauncher(root))
    expect(await exitOf(launcher)).toBe(0)
    expect(host.boots()).toHaveLength(1)
    expect(existsSync(join(root, 'computer-runtime', 'host-quarantine.json'))).toBe(false)
    expect(JSON.parse(readFileSync(pointer, 'utf8')).current.version).toBe('2')
    expect(computerLog(root)).toMatch(
      new RegExp(
        `host 2 pid=\\d+ exited code=${code} signal=null after \\d+ms; superseded by a live session host, stopping`
      )
    )
    const dir = hostEndpointDir(root)
    if (dir) expect(existsSync(dir)).toBe(false)
  },
  15_000
)

// 2026-11-28 on a remote computer upgraded from 0.43.0: two redundant launchers from
// before the lock (pre-lock launch.cjs, still running in memory) restarted their
// session host every ~2s for hours, each child dying on the live host's endpoint.
// A superseded host must stop THAT launcher too — not be restarted forever, and
// never get its release quarantined and rolled back.
it('a pre-lock launcher (<= 0.43.0) stands down when its child is superseded: no restart, no quarantine, no rollback', async () => {
  const root = launcherRoot('launcher-pre-lock-superseded-')
  const host = hostEntry(root, SUPERSEDED_HOST)
  const good = join(root, 'good.cjs')
  writeFileSync(good, 'setInterval(()=>{},1000)')
  ensureComputerLauncher(root, { entry: good, version: '1' })
  const runtime = join(root, 'computer-runtime')
  writeFileSync(join(runtime, 'launch.cjs'), PRE_LOCK_COMPUTER_LAUNCHER, { mode: 0o700 })
  // As an upgrade leaves it: the new release current, the live host's previous.
  const pointer = join(runtime, 'host-release.json')
  writeFileSync(
    pointer,
    JSON.stringify({
      current: { entry: host.entry, version: '2' },
      previous: { entry: good, version: '1' }
    })
  )
  const launcher = track(hostLauncher(root))
  // It ends on its own (its fixed restart delay is 2s: well inside this wait).
  const exited = await Promise.race([
    exitOf(launcher),
    new Promise<'running'>((r) => setTimeout(() => r('running'), 5000))
  ])
  expect(exited).toBe(0)
  expect(host.boots()).toHaveLength(1)
  expect(existsSync(join(runtime, 'host-quarantine.json'))).toBe(false)
  expect(JSON.parse(readFileSync(pointer, 'utf8')).current.version).toBe('2')
}, 15_000)

it('the host launcher reports its backoff, and launch-now cuts it short', async () => {
  const root = launcherRoot('launcher-status-')
  // First boot fails; the second stays up.
  const host = hostEntry(root, 'if(n===1)process.exit(3);setInterval(()=>{},1000)')
  ensureComputerLauncher(root, { entry: host.entry, version: '1' })
  const launcher = join(root, 'computer-runtime', 'launch.cjs')
  writeFileSync(
    launcher,
    readFileSync(launcher, 'utf8').replace('BACKOFF_MIN_MS = 2000', 'BACKOFF_MIN_MS = 60000')
  )
  const proc = track(hostLauncher(root))
  await until(() => host.boots().length === 1)
  let status = await queryHostLauncher(root, 'status')
  await until(() => {
    void queryHostLauncher(root, 'status').then((s) => (status = s))
    return status?.state === 'backoff'
  })
  expect(status).toMatchObject({
    state: 'backoff',
    childPid: null,
    lastExit: { code: 3, signal: null, version: '1' }
  })
  expect(status!.nextLaunchAt).toBeGreaterThan(Date.now() + 50_000)
  status = await queryHostLauncher(root, 'launch-now')
  await until(() => host.boots().length === 2)
  killPids.push(...host.boots())
  status = await queryHostLauncher(root, 'status')
  expect(status).toMatchObject({
    state: 'running',
    childPid: host.boots()[1],
    nextLaunchAt: null
  })
  expect(proc.exitCode).toBeNull()
}, 15_000)

it('no launcher: the status query answers null', async () => {
  const root = launcherRoot('launcher-none-')
  expect(await queryHostLauncher(root, 'status')).toBeNull()
})

/** Bind something (not a launcher) to the root's launcher endpoint. */
async function occupyLauncherEndpoint(
  root: string,
  onConnection: (s: import('node:net').Socket) => void
): Promise<Server> {
  const dir = hostEndpointDir(root)
  if (dir) prepareEndpointDir(dir)
  const server = createServer(onConnection)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(hostLauncherEndpoint(root), resolve)
  })
  launcherCleanup.push(() => server.close())
  return server
}

it('a launcher bound but not answering is reported busy (still the owner)', async () => {
  const root = launcherRoot('launcher-busy-')
  await occupyLauncherEndpoint(root, () => undefined)
  await expect(queryHostLauncher(root, 'status', 300)).rejects.toBeInstanceOf(HostLauncherBusyError)
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a launcher endpoint that cannot be reached is an error, never "busy"',
  async () => {
    const root = launcherRoot('launcher-eacces-')
    await occupyLauncherEndpoint(root, (s) => s.end())
    chmodSync(hostLauncherEndpoint(root), 0)
    const err = await queryHostLauncher(root, 'status').catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'EACCES' })
    expect(err).not.toBeInstanceOf(HostLauncherBusyError)
  }
)

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a host launcher that cannot probe its endpoint stops with the error, not as superseded',
  async () => {
    const root = launcherRoot('launcher-probe-error-')
    const host = hostEntry(root)
    ensureComputerLauncher(root, { entry: host.entry, version: '1' })
    await occupyLauncherEndpoint(root, (s) => s.end())
    chmodSync(hostLauncherEndpoint(root), 0)
    const launcher = track(hostLauncher(root))
    expect(await exitOf(launcher)).toBe(1)
    expect(host.boots()).toHaveLength(0)
    expect(computerLog(root)).toMatch(/cannot probe .*EACCES/)
    expect(computerLog(root)).not.toMatch(/superseded/)
  },
  15_000
)

it.skipIf(process.platform === 'win32')(
  'a host launcher whose endpoint path is over the socket path limit says so and stops',
  async () => {
    const root = launcherRoot('launcher-overlong-')
    const host = hostEntry(root)
    ensureComputerLauncher(root, { entry: host.entry, version: '1' })
    const launcher = track(
      spawn(process.execPath, [join(root, 'computer-runtime', 'launch.cjs'), '--session-host'], {
        env: { ...process.env, SLAYZONE_ROOT: root, TMPDIR: join(root, 'y'.repeat(100)) },
        stdio: 'ignore'
      })
    )
    expect(await exitOf(launcher)).toBe(1)
    expect(host.boots()).toHaveLength(0)
    expect(computerLog(root)).toMatch(
      /computer endpoint .* is \d+ bytes, over the 10[48]-byte Unix socket path limit/
    )
  },
  15_000
)
