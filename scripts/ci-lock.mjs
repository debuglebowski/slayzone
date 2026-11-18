#!/usr/bin/env node
/**
 * Machine-wide, first-come-first-served lock around SlayZone's heavy local runs
 * (`pnpm test:e2e`, `test:e2e:perf`, `test:e2e:chat`, `test:unit`, `test:unit:fast`, and
 * iOS builds through scripts/ios-build.mjs).
 * Other repos on the same machine take the same lock (madacademy `ci/lock.sh`, its merge
 * gate), so two heavy runs never load the box at once: the later one waits its turn.
 *
 *   node scripts/ci-lock.mjs <label> -- <command> [args...]
 *
 * Protocol — shared with madacademy ci/lock.sh, so keep paths and file formats in step:
 *   - Queue dir /tmp/ci-local.queue: one ticket per waiter or holder, named
 *     `<epoch seconds>-<pid>`, containing `<who>`. Tickets whose pid is dead are removed.
 *   - Lock dir /tmp/ci-local.lock (mkdir is the atomic take) holding files `pid` and `who`.
 *     A lock whose pid is dead is stale and removed.
 *   - The oldest ticket (epoch, then pid) takes the lock; waiters poll every 5 s.
 *   - Release removes the lock dir and the ticket: on exit, on Ctrl-C, on failure.
 * Only the queue head clears a stale lock (so two of our waiters never race a remove
 * against a fresh take), and a lock left without a `pid` file (holder killed between
 * mkdir and writing it) counts as stale after a grace period.
 *
 * Skipped (command runs directly) when CI is set (GitHub Actions), when SLZ_NO_CI_LOCK=1,
 * and when an ancestor already decided: the command runs with SLZ_CI_LOCK_HELD=1, so a
 * locked script that starts another locked script does not wait on itself.
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SHARED_DIR = process.platform === 'win32' ? tmpdir() : '/tmp'
export const DEFAULT_PATHS = {
  lockDir: join(SHARED_DIR, 'ci-local.lock'),
  queueDir: join(SHARED_DIR, 'ci-local.queue')
}
export const POLL_MS = 5000
/** A lock dir with no `pid` file older than this is a holder that died mid-take. */
export const NO_PID_GRACE_MS = 30_000

/** Same test as `kill -0 <pid>`: EPERM means the process exists (another user's). */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** `<epoch>-<pid>` → [epoch, pid]; anything else → NaNs (pruned as dead, sorted last). */
function parseTicket(name) {
  const dash = name.lastIndexOf('-')
  return [Number(name.slice(0, dash)), Number(name.slice(dash + 1))]
}

/** Ticket names oldest first, as `sort -t- -k1,1n -k2,2n` orders them. */
export function sortTickets(names) {
  const key = (n) => parseTicket(n).map((v) => (Number.isFinite(v) ? v : Infinity))
  return [...names].sort((a, b) => {
    const [ae, ap] = key(a)
    const [be, bp] = key(b)
    return ae - be || ap - bp || (a < b ? -1 : a > b ? 1 : 0)
  })
}

function readTrimmed(file) {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return null
  }
}

/** Current holder of the lock, or null when nobody holds it. */
export function readLock(lockDir) {
  if (!existsSync(lockDir)) return null
  const pid = readTrimmed(join(lockDir, 'pid'))
  const who = readTrimmed(join(lockDir, 'who'))?.replace(/\s+/g, ' ') // some writers put several lines
  return { pid: pid ? Number(pid) : null, who: who || '?' }
}

function lockIsStale(lockDir, now) {
  const lock = readLock(lockDir)
  if (!lock) return false
  if (lock.pid !== null) return !isAlive(lock.pid)
  try {
    return now - statSync(lockDir).mtimeMs > NO_PID_GRACE_MS
  } catch {
    return false
  }
}

/** Enqueues this process: writes `<queueDir>/<epoch>-<pid>` containing `who`. */
export function enqueue({ queueDir, who, pid = process.pid, now = Date.now() }) {
  mkdirSync(queueDir, { recursive: true })
  const ticket = join(queueDir, `${Math.floor(now / 1000)}-${pid}`)
  writeFileSync(ticket, `${who}\n`)
  return ticket
}

/**
 * One poll: drop dead tickets, and when `ticket` is the oldest, clear a stale lock and try
 * to take it. Returns { acquired: true } or { acquired: false, holder (null: free), queued }.
 */
export function tryAcquire({
  lockDir,
  queueDir,
  ticket,
  who,
  pid = process.pid,
  now = Date.now()
}) {
  mkdirSync(queueDir, { recursive: true })
  if (!existsSync(ticket)) writeFileSync(ticket, `${who}\n`) // queue dir wiped under us
  for (const name of readdirSync(queueDir)) {
    if (!isAlive(parseTicket(name)[1])) rmSync(join(queueDir, name), { force: true })
  }
  const queue = sortTickets(readdirSync(queueDir))
  if (queue[0] === basename(ticket)) {
    if (lockIsStale(lockDir, now)) rmSync(lockDir, { recursive: true, force: true })
    let took = false
    try {
      mkdirSync(lockDir)
      took = true
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    if (took) {
      writeFileSync(join(lockDir, 'pid'), `${pid}\n`)
      writeFileSync(join(lockDir, 'who'), `${who}\n`)
      return { acquired: true }
    }
  }
  return { acquired: false, holder: readLock(lockDir)?.who ?? null, queued: queue.length }
}

/** Removes the lock (only if this pid holds it) and the ticket. Safe to call twice. */
export function release({ lockDir, ticket, pid = process.pid }) {
  if (readLock(lockDir)?.pid === pid) rmSync(lockDir, { recursive: true, force: true })
  if (ticket) rmSync(ticket, { force: true })
}

/** Why the lock is not taken for this run, or null when it is. */
export function skipReason(env = process.env) {
  if (env.SLZ_CI_LOCK_HELD) return 'held' // an ancestor already took it (or skipped it)
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return 'CI'
  if (env.SLZ_NO_CI_LOCK === '1') return 'SLZ_NO_CI_LOCK=1'
  return null
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']
const osSignals = constants.signals

/**
 * Waits for the lock (unless skipped), runs `cmd` in `cwd` (stdin: `stdin`) with SLZ_CI_LOCK_HELD=1,
 * releases it when the command exits, and resolves `{ code, signal }` of the command. For a
 * caller that keeps running after the locked part (scripts/ios-build.mjs: build locked,
 * Metro not).
 */
export async function runCommandLocked({
  label,
  cmd,
  paths = DEFAULT_PATHS,
  pollMs = POLL_MS,
  env = process.env,
  cwd = process.cwd(),
  stdin = 'inherit',
  log = (m) => process.stderr.write(`${m}\n`)
}) {
  const skip = skipReason(env)
  const who = `${label}:${repoName()}`
  let ticket = null
  const drop = () => release({ lockDir: paths.lockDir, ticket })

  if (skip === null) {
    ticket = enqueue({ queueDir: paths.queueDir, who })
    process.on('exit', drop) // backstop: an uncaught error still releases
    const onWaitSignal = (sig) => {
      drop()
      process.exit(128 + osSignals[sig])
    }
    for (const sig of SIGNALS) process.on(sig, onWaitSignal)
    let said = ''
    for (;;) {
      const r = tryAcquire({ lockDir: paths.lockDir, queueDir: paths.queueDir, ticket, who })
      if (r.acquired) break
      const state = r.holder === null ? 'free, an earlier ticket goes first' : `held by ${r.holder}`
      const line = `ci-lock: ${who} waiting for the machine-wide CI lock (${state}; ${r.queued} in queue, first come first served)...`
      if (line !== said) log(line)
      said = line
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    for (const sig of SIGNALS) process.off(sig, onWaitSignal)
    if (said) log(`ci-lock: ${who} has the lock`)
  } else if (skip !== 'held') {
    log(`ci-lock: not taking the machine-wide CI lock (${skip})`)
  }

  const child = spawn(cmd[0], cmd.slice(1), {
    stdio: [stdin, 'inherit', 'inherit'],
    cwd,
    env: { ...env, SLZ_CI_LOCK_HELD: '1' },
    shell: process.platform === 'win32' // pnpm / npx are .cmd shims there
  })
  // Ctrl-C reaches the whole foreground process group, the command included: stay alive
  // until it exits. A SIGTERM / SIGHUP sent to this process alone is passed on.
  const onRunSignal = (sig) => {
    if (sig !== 'SIGINT') child.kill(sig)
  }
  for (const sig of SIGNALS) process.on(sig, onRunSignal)
  const [code, signal] = await new Promise((resolve) => {
    child.on('error', (err) => {
      log(`ci-lock: cannot run ${cmd[0]}: ${err.message}`)
      resolve([127, null])
    })
    child.on('exit', (c, s) => resolve([c, s]))
  })
  drop()
  process.off('exit', drop)
  for (const sig of SIGNALS) process.off(sig, onRunSignal)
  return { code, signal }
}

/** Exits like a finished command did: same signal, or same code. */
export function exitLike({ code, signal }) {
  if (signal) {
    process.kill(process.pid, signal) // no listeners left: die of it, like the command
    setTimeout(() => process.exit(128 + (osSignals[signal] ?? 0)), 1000)
    return
  }
  process.exit(code ?? 1)
}

/** {@link runCommandLocked}, then exit like the command did. */
export async function runLocked(opts) {
  exitLike(await runCommandLocked(opts))
}

function repoName() {
  const root = basename(dirname(dirname(fileURLToPath(import.meta.url))))
  return root === 'slayzone' ? 'slayzone' : `slayzone/${root}` // worktrees: say which
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2)
  const sep = argv.indexOf('--')
  if (sep !== 1 || argv.length < 3) {
    process.stderr.write('usage: node scripts/ci-lock.mjs <label> -- <command> [args...]\n')
    process.exit(2)
  }
  await runLocked({ label: argv[0], cmd: argv.slice(2) })
}
