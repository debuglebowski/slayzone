import { SUPERVISED_STOP_SIGKILL_GRACE_MS } from '@slayzone/platform/parent-watch'

/**
 * The reap of a supervised child — the local hub, the local computer — during an
 * app quit: wait for its supervisor's `stop()` (SIGTERM, then SIGKILL after the
 * grace period) inside one deadline.
 *
 * Fired and forgotten, the stop lost the race with the process exit: Electron main
 * was gone before the SIGKILL escalation could land, so a child that did not exit
 * on SIGTERM was orphaned (ppid 1) — a computer with every agent pty still under it
 * and the computer id the next app's computer needed, a hub with the port and the
 * database the next app's hub needed. The deadline keeps a child that survives
 * even SIGKILL (uninterruptible sleep) from holding the quit open; the child's own
 * parent watch ends it once the app is gone.
 */
/**
 * How long the quit waits for EACH supervised child. Derived, never set: past its
 * supervisor's SIGKILL (SUPERVISED_STOP_SIGKILL_GRACE_MS, itself past the child's
 * own stop deadline) plus a margin for the kill to land, so the quit only gives up
 * on a child that survives even SIGKILL. The reaps run in parallel, so this also
 * bounds both together.
 */
export const QUIT_CHILD_REAP_MS = SUPERVISED_STOP_SIGKILL_GRACE_MS + 1_000

export type QuitReapResult =
  /** The child is gone. */
  | 'stopped'
  /** No such child was ever started (remote mode, or quit during boot). */
  | 'none'
  /** Still not reaped at the deadline; the quit proceeds without it. */
  | 'timed-out'
  /** `stop()` threw; the quit proceeds. */
  | 'failed'

export async function reapChildForQuit(deps: {
  /** The supervisor handle's `stop`, or null when there is none. */
  stop: (() => Promise<void>) | null
  timeoutMs: number
}): Promise<QuitReapResult> {
  const { stop } = deps
  if (!stop) return 'none'
  const reap = (async () => {
    try {
      await stop()
      return 'stopped' as const
    } catch {
      return 'failed' as const
    }
  })()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), deps.timeoutMs)
  })
  const result = await Promise.race([reap, deadline])
  clearTimeout(timer)
  return result
}
