/**
 * The local-computer reap of an app quit: wait for the supervisor's `stop()` —
 * SIGTERM, then SIGKILL after its grace period — inside one deadline.
 *
 * Fired and forgotten, the stop lost the race with the process exit: Electron main
 * was gone before the SIGKILL escalation could land, so a computer that did not
 * exit on SIGTERM was orphaned (ppid 1) with every agent pty still under it, and
 * held the computer id the next app's computer needed. The deadline keeps a
 * computer that survives even SIGKILL (uninterruptible sleep) from holding the
 * quit open; the computer's own parent watch ends it once the app is gone.
 */
export type LocalComputerQuitResult =
  /** The computer is gone. */
  | 'stopped'
  /** No local computer was ever started (remote mode, or quit during boot). */
  | 'none'
  /** Still not reaped at the deadline; the quit proceeds without it. */
  | 'timed-out'
  /** `stop()` threw; the quit proceeds. */
  | 'failed'

export async function stopLocalComputerForQuit(deps: {
  /** The supervisor handle's `stop`, or null when there is none. */
  stop: (() => Promise<void>) | null
  timeoutMs: number
}): Promise<LocalComputerQuitResult> {
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
