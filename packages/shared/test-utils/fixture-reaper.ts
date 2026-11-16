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
 * SIGKILLs every process rooted in `dir` (its command line names `dir`, or it descends
 * from one that does), repeating until none is left (supervisors respawn), then removes
 * `dir`. If `dir` disappears first (normal cleanup), it exits without touching anything.
 *
 * Every fixture process must name `dir` in its command line or descend from one that
 * does: the fixture's entry script lives under it. A process started from a script
 * outside `dir` (a repo `dist/bin.cjs`) gets {@link fixtureMarkerArgs} in front.
 *
 * A test's own teardown calls {@link killFixtureProcesses} (the same rule, at once),
 * and the harness fails any file that leaves such processes behind (fixture-guard.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as core from './fixture-processes.cjs'

export type { FixtureProcess } from './fixture-processes.cjs'

/** The live processes rooted in `dirs`: naming one, or descending from one that does. */
export const fixtureProcesses = core.fixtureProcesses

/** SIGKILL every process rooted in `dirs` until none is left; returns those killed. */
export const killFixtureProcesses = core.killFixtureProcesses

/**
 * Node/Electron arguments that make a process name `dir` although its script lives
 * elsewhere: `--require <dir>/.fixture-marker.cjs` (an empty module). Put them before
 * the script.
 */
export function fixtureMarkerArgs(dir: string): string[] {
  const marker = join(dir, '.fixture-marker.cjs')
  writeFileSync(marker, '')
  return ['--require', marker]
}

/** Watch `ownerPid`; reap `dir`'s processes if it dies before `dir` is removed. */
export function spawnFixtureReaper(dir: string, ownerPid: number): ChildProcess {
  const watchdog = spawn(process.execPath, [core.WATCHDOG_PATH, String(ownerPid), dir], {
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
