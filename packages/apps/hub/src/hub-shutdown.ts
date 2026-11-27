import { SUPERVISED_STOP_DEADLINE_MS } from '@slayzone/platform/parent-watch'
import { HUB_RESTART_EXIT_CODE } from './hub-restart.js'

/**
 * How the hub process ends (bin.ts). Only the first call counts.
 *
 * `exitCode` 75 = a planned restart (hub-restart.ts): it is set on the process FIRST,
 * so the process ends as 75 however it ends — a clean stop, the deadline, or the event
 * loop draining on its own (both deadline timers are unref'd, review-2 L3).
 *
 * Deadlines. A restart is bounded on EVERY hub: a server hub that hung here would be a
 * live process to systemd/launchd, so nothing would start it again and the staged
 * restore would wait forever; exiting 75 late is safe (the marker is durable). A
 * supervised hub's plain stop is bounded too: once the app is gone nothing else would
 * end it, and it would hold the port and the database the next app's hub needs. Its
 * supervisor's SIGKILL comes only after this deadline. Unref'd: a clean stop still
 * exits the moment it completes.
 */
export function createShutdown(opts: {
  stop: () => Promise<void>
  supervised: boolean
  proc: { exitCode?: number | string | null; exit: (code: number) => void }
  log: (line: string) => void
  deadlineMs?: number
}): (reason: string, exitCode?: number) => Promise<void> {
  let shuttingDown = false
  const deadlineMs = opts.deadlineMs ?? SUPERVISED_STOP_DEADLINE_MS
  return async (reason, exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    opts.proc.exitCode = exitCode
    opts.log(`[slayzone-server] shutting down (${reason})`)
    if (exitCode === HUB_RESTART_EXIT_CODE) {
      setTimeout(() => {
        opts.log(
          `[slayzone-server] restart still stopping after ${deadlineMs}ms — exiting ${HUB_RESTART_EXIT_CODE}`
        )
        opts.proc.exit(HUB_RESTART_EXIT_CODE)
      }, deadlineMs).unref?.()
    } else if (opts.supervised) {
      setTimeout(() => {
        opts.log(`[slayzone-server] still running ${deadlineMs}ms after stop began — forcing exit`)
        opts.proc.exit(1)
      }, deadlineMs).unref?.()
    }
    try {
      await opts.stop()
      opts.proc.exit(exitCode)
    } catch (err) {
      opts.log(
        `[slayzone-server] shutdown error: ${err instanceof Error ? err.stack : String(err)}`
      )
      opts.proc.exit(1)
    }
  }
}
