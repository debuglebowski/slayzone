/**
 * The startup deadline for a spawned session: no output AT ALL within
 * `timeoutMs` of the spawn ⇒ it is hung, and the owner kills it.
 *
 * Shared by the two places that run one: the computer, which owns its sessions'
 * processes and is the side that should judge them, and the hub's pty-manager,
 * which keeps its own only for a backend that does not (the in-process test
 * backend, and computers that predate computer-side deadlines).
 *
 * ── Drain before the verdict ────────────────────────────────────────────────
 * After the event loop has been blocked, Node runs every due TIMER before it
 * polls I/O. A deadline that decides inside its own timer therefore judges a
 * session silent while its output is already sitting, unread, in a kernel buffer
 * — a stall longer than the deadline makes every session in flight look hung at
 * once. On 2026-10-23 a ~20s hub stall did exactly that to 13 healthy agents.
 *
 * So the timer only OPENS the verdict, and `setImmediate` delivers it: the check
 * phase runs after the poll phase of the same loop turn, so any output that was
 * already waiting has been read (and has called `markOutput`) by then. Not a
 * longer timeout, not a grace period — the deadline is unchanged, it just stops
 * deciding before it has looked.
 *
 * @module platform/startup-deadline
 */

export interface StartupDeadline {
  /** First output seen: the session is alive. Clears the deadline for good. */
  markOutput(): void
  /** The session ended or was replaced: drop the deadline without a verdict. */
  cancel(): void
}

export interface StartupDeadlineOptions {
  timeoutMs: number
  /** Called at most once, only if no output arrived in time. */
  onExpire: () => void
}

export function armStartupDeadline({
  timeoutMs,
  onExpire
}: StartupDeadlineOptions): StartupDeadline {
  let settled = false
  let verdict: ReturnType<typeof setImmediate> | null = null
  const timer = setTimeout(() => {
    verdict = setImmediate(() => {
      verdict = null
      if (settled) return
      settled = true
      onExpire()
    })
  }, timeoutMs)
  // A deadline is bookkeeping about a session, never a reason to keep a process
  // alive on its own.
  timer.unref?.()

  const stop = (): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (verdict) clearImmediate(verdict)
  }
  return { markOutput: stop, cancel: stop }
}
