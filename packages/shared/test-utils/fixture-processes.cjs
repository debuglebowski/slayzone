'use strict'
/**
 * Find and kill a test fixture's processes: every process whose command line names the
 * fixture's dir, plus all of their descendants (a computer's `dist/bin.cjs --supervisor`
 * names no dir; only the launcher above it does).
 *
 * Plain CommonJS so the reaper watchdog (fixture-reaper-watchdog.cjs) runs it under bare
 * node, with no transform; fixture-reaper.ts and fixture-guard.ts load the same code.
 */
const { execFileSync } = require('node:child_process')
const { realpathSync } = require('node:fs')
const { join, sep } = require('node:path')

/** The watchdog's own script name: never a fixture process, though it names the dir. */
const WATCHDOG_SCRIPT = 'fixture-reaper-watchdog.cjs'
/** Where the watchdog script is (fixture-reaper.ts starts it). */
const WATCHDOG_PATH = join(__dirname, WATCHDOG_SCRIPT)

/** Every process on the machine as { pid, ppid, args }. */
function listProcesses() {
  const out =
    process.platform === 'win32'
      ? execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }'
          ],
          { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
        )
      : execFileSync('ps', ['-Ao', 'pid=,ppid=,args='], {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024
        })
  const procs = []
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line)
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] })
  }
  return procs
}

/** The spellings a command line may use for `dir`: as given, and its realpath. */
function dirForms(dir) {
  const forms = new Set([dir])
  try {
    forms.add(realpathSync(dir))
  } catch {
    /* already removed: the given spelling is all there is */
  }
  return [...forms]
}

/** Whether `args` names `dir` itself or a path inside it (never a sibling `<dir>x`). */
function namesDir(args, forms) {
  for (const f of forms) {
    let at = args.indexOf(f)
    while (at !== -1) {
      const next = args.charAt(at + f.length)
      if (next === '' || next === sep || next === '/' || /\s|["']/.test(next)) return true
      at = args.indexOf(f, at + 1)
    }
  }
  return false
}

/**
 * The live processes rooted in any of `dirs`: those naming one, and their descendants.
 * Never this process, its ancestors, or a reaper watchdog.
 * @param {string | string[]} dirs  dirs, or [dir, realpath] forms already resolved
 * @param {{ procs?: Array<{pid:number, ppid:number, args:string}> }} [opts]
 */
function fixtureProcesses(dirs, opts = {}) {
  const forms = (Array.isArray(dirs) ? dirs : [dirs]).flatMap(dirForms)
  const procs = opts.procs ?? listProcesses()
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const skip = new Set()
  for (let pid = process.pid; pid > 1 && !skip.has(pid); pid = byPid.get(pid)?.ppid ?? 0) {
    skip.add(pid)
  }
  const children = new Map()
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, [])
    children.get(p.ppid).push(p)
  }
  const found = new Map()
  const queue = procs.filter((p) => namesDir(p.args, forms) && !p.args.includes(WATCHDOG_SCRIPT))
  while (queue.length > 0) {
    const p = queue.shift()
    if (found.has(p.pid) || skip.has(p.pid)) continue
    found.set(p.pid, p)
    for (const c of children.get(p.pid) ?? []) queue.push(c)
  }
  return [...found.values()]
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * SIGKILL every process rooted in `dirs`, round after round until none is left (a
 * supervisor respawns its child). The descendants are collected before anything dies:
 * a killed parent's children reparent to init and no longer look like its own.
 * Returns every process it killed.
 * @param {string | string[]} dirs
 * @param {{ rounds?: number }} [opts]
 */
function killFixtureProcesses(dirs, opts = {}) {
  const forms = (Array.isArray(dirs) ? dirs : [dirs]).flatMap(dirForms)
  const killed = new Map()
  for (let round = 0; round < (opts.rounds ?? 20); round++) {
    let found = []
    try {
      found = fixtureProcesses(forms)
    } catch {
      /* ps failed this round; try again */
    }
    if (found.length === 0) break
    for (const p of found) {
      try {
        process.kill(p.pid, 'SIGKILL')
        killed.set(p.pid, p)
      } catch {
        /* already gone */
      }
    }
    sleepSync(100)
  }
  return [...killed.values()]
}

module.exports = {
  WATCHDOG_PATH,
  WATCHDOG_SCRIPT,
  dirForms,
  fixtureProcesses,
  killFixtureProcesses,
  listProcesses
}
