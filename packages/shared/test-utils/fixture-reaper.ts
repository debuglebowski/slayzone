/**
 * Kill a test fixture's process tree when the test dies without cleaning up.
 *
 * A test's `finally` stops what it spawned only if the test gets to run it. When the
 * worker is killed first (test timeout teardown, a SIGKILL'd vitest, an agent's command
 * timing out), detached fixture processes reparent to init and keep running. A computer
 * supervisor fixture then respawns its child every few seconds against a hub that is
 * gone, forever: several such leaks once held a dev machine at load 150.
 *
 * `reapOnOwnerDeath(dir)` starts a small detached watchdog. While the owner (this test
 * process) lives it does nothing. If the owner dies while `dir` still exists, it
 * SIGKILLs every process whose command line names `dir`, repeating until none is left
 * (supervisors respawn), then removes `dir`. If `dir` disappears first (normal
 * cleanup), it exits without touching anything.
 *
 * Every fixture process must name `dir` in its command line: the fixture's entry
 * script lives under it.
 */
import { spawn, type ChildProcess } from 'node:child_process'

const WATCHDOG = String.raw`
const { execFileSync } = require('node:child_process')
const { existsSync, rmSync } = require('node:fs')
const { sep } = require('node:path')
const [owner, dir] = process.argv.slice(-2).map((v, i) => (i === 0 ? Number(v) : v))
const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
const names = (cmd) => cmd.includes(dir + sep) || cmd.endsWith(dir)
const fixturePids = () => {
  const out = process.platform === 'win32'
    ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'],
        { encoding: 'utf8', windowsHide: true })
    : execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8' })
  const pids = []
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m && Number(m[1]) !== process.pid && names(m[2])) pids.push(Number(m[1]))
  }
  return pids
}
const reap = () => {
  for (let round = 0; round < 20; round++) {
    let pids = []
    try { pids = fixturePids() } catch {}
    if (pids.length === 0) break
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch {} }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  }
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch {}
}
const tick = setInterval(() => {
  if (!existsSync(dir)) process.exit(0)
  if (!alive(owner)) { clearInterval(tick); reap(); process.exit(0) }
}, 500)
`

/** Watch `ownerPid`; reap `dir`'s processes if it dies before `dir` is removed. */
export function spawnFixtureReaper(dir: string, ownerPid: number): ChildProcess {
  const watchdog = spawn(process.execPath, ['-e', WATCHDOG, String(ownerPid), dir], {
    // The harness runs under Electron's node; without this the watchdog is a GUI app.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  watchdog.unref()
  return watchdog
}

/** Reap `dir`'s fixture processes if this test process dies before removing `dir`. */
export function reapOnOwnerDeath(dir: string): ChildProcess {
  return spawnFixtureReaper(dir, process.pid)
}
