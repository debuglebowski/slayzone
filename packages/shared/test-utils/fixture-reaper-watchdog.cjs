'use strict'
/**
 * The detached watchdog fixture-reaper.ts starts: `node fixture-reaper-watchdog.cjs
 * <owner pid> <dir>`. While the owner lives it does nothing. If the owner dies while
 * `dir` still exists, it kills every process rooted in `dir` (fixture-processes.cjs),
 * then removes `dir`. If `dir` disappears first (normal cleanup), it exits.
 */
const { existsSync, rmSync } = require('node:fs')
const { dirForms, killFixtureProcesses } = require('./fixture-processes.cjs')

const [ownerArg, dir] = process.argv.slice(-2)
const owner = Number(ownerArg)
// Resolved now: the realpath is gone once the dir is.
const forms = dirForms(dir)
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
const tick = setInterval(() => {
  if (!existsSync(dir)) process.exit(0)
  if (!alive(owner)) {
    clearInterval(tick)
    killFixtureProcesses(forms)
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      /* best effort */
    }
    process.exit(0)
  }
}, 500)
