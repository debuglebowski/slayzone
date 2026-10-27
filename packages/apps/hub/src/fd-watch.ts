/**
 * Open-file watchdog: warns in diagnostics when the hub holds an unusual number of
 * file descriptors, so a leak shows up long before the hub runs out and every spawn
 * fails. (A transcript-reader leak once grew to ~10k fds over 34h; the first symptom
 * the user saw was the git panel calling a healthy repo "not a git repository".)
 *
 *   - one count at start, then every {@link FD_CHECK_INTERVAL_MS}; the timer is unref'd;
 *   - one `server.fd_high` warning on crossing {@link FD_WARN_THRESHOLD}, then one per
 *     doubling — never one per tick;
 *   - re-armed once the count falls back under the threshold;
 *   - no timer where fds can't be counted (Windows).
 *
 * @module server/fd-watch
 */
import { readdirSync } from 'node:fs'
import type { DiagnosticEvent } from '@slayzone/diagnostics/shared'

export const FD_CHECK_INTERVAL_MS = 60_000
/** Well above a healthy hub (~50–300 fds), well below the usual per-process limits. */
export const FD_WARN_THRESHOLD = 2048

/** This process's open descriptors, or null where that can't be listed. */
export function countOpenFds(): number | null {
  const dir =
    process.platform === 'linux'
      ? '/proc/self/fd'
      : process.platform === 'darwin'
        ? '/dev/fd'
        : null
  if (!dir) return null
  try {
    return readdirSync(dir).length
  } catch {
    return null
  }
}

export interface FdWatchTimers {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

const realTimers: FdWatchTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout)
}

export interface FdWatchHandle {
  /** False where fds can't be counted: no timer exists. */
  readonly active: boolean
  stop(): void
}

export function startFdWatch(opts: {
  record: (event: DiagnosticEvent) => void
  countFds?: () => number | null
  timers?: FdWatchTimers
}): FdWatchHandle {
  const countFds = opts.countFds ?? countOpenFds
  const timers = opts.timers ?? realTimers
  // Next count that warns: the threshold, then double the last warned level.
  let nextWarnAt = FD_WARN_THRESHOLD
  /** One count; false where fds can't be counted. */
  const tick = (): boolean => {
    const openFds = countFds()
    if (openFds === null) return false
    if (openFds < FD_WARN_THRESHOLD) {
      nextWarnAt = FD_WARN_THRESHOLD
      return true
    }
    if (openFds < nextWarnAt) return true
    while (nextWarnAt <= openFds) nextWarnAt *= 2
    opts.record({
      level: 'warn',
      source: 'server',
      event: 'server.fd_high',
      message: `hub has ${openFds} open file descriptors — likely a leak (inspect with: lsof -p ${process.pid})`,
      payload: { openFds, pid: process.pid, nextWarnAt }
    })
    return true
  }
  // The first count runs now: it also tells whether this platform can count at all.
  if (!tick()) return { active: false, stop: () => {} }
  const handle = timers.setInterval(() => void tick(), FD_CHECK_INTERVAL_MS)
  return { active: true, stop: () => timers.clearInterval(handle) }
}
