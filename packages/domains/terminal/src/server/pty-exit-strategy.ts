/**
 * Pure decision logic for PTY exit handling.
 * Extracted from pty-manager to enable unit testing.
 */

export interface ExitContext {
  exitCode: number
  terminalMode: string
  hasPostSpawnCommand: boolean
  resuming: boolean
  usedShellFallback: boolean
  /** The non-zero exit was a stale `--resume` (provider auto-cleaned the
   *  session — issue #90). When true, suppress the shell fallback so the
   *  friendly "session expired" dead overlay surfaces instead of burying the
   *  "No conversation found" error in a raw recovery shell. */
  isStale: boolean
}

/** Should we spawn an interactive shell after the CLI exits? */
export function shouldShellFallback(ctx: ExitContext): boolean {
  return ctx.hasPostSpawnCommand && ctx.exitCode !== 0 && !ctx.usedShellFallback && !ctx.isStale
}

/**
 * How a pty's spawn was confirmed: `'synchronous'` for an in-process spawn (the
 * pty exists the moment the handle does), or the owner's confirmation reply.
 */
export type SpawnConfirmationState = 'synchronous' | { ownsStartupDeadline?: boolean }

/**
 * Should the HUB arm its own startup deadline for this pty?
 *
 * Only when nothing closer to the process owns one. A deadline judged across a
 * socket cannot tell "printed nothing" from "printed, but not yet read by me" —
 * after a hub stall it killed agents whose output was already waiting in the
 * hub's own buffers. So a computer that confirms it armed the deadline is never
 * second-guessed; an in-process spawn, or a computer that predates computer-side
 * deadlines, still gets the hub's.
 */
export function shouldArmHubStartupDeadline(confirmation: SpawnConfirmationState): boolean {
  if (confirmation === 'synchronous') return true
  return confirmation.ownsStartupDeadline !== true
}

/** Build the recovery message shown in the terminal buffer. */
export function buildRecoveryMessage(terminalMode: string, exitCode: number): string {
  return `\r\n[SlayZone] ${terminalMode} exited with code ${String(exitCode)}. Switched to interactive shell for recovery.\r\n`
}

/**
 * State observed when an AWAITED (computer-routed) recovery-shell spawn resolves.
 *
 * Only the remote path can observe these: a local spawn is synchronous inside
 * `onExit`, so nothing can intervene between deciding to recover and holding
 * the new pty. A remote spawn is a network round-trip, and the session can be
 * torn down while it is in flight.
 */
export interface RecoveryAdoptionContext {
  /** The exit has already been reported (a concurrent path called finalize). */
  finalized: boolean
  /** The session id no longer maps to the session that started this recovery —
   *  closed, or replaced by a newer session reusing the id. */
  sessionReplaced: boolean
  /** App-wide shutdown: the map may still be intact, but no pty may be adopted. */
  isShuttingDown: boolean
}

/** What to do with a recovery shell that has just finished spawning. */
export type RecoveryAdoption =
  | { action: 'adopt' }
  /** Kill the orphan. `finalize` is true when the exit still needs reporting —
   *  false when a concurrent path already did it (double-finalize is a no-op,
   *  but deciding it here keeps the caller from having to re-derive it). */
  | { action: 'discard'; finalize: boolean }

/**
 * Decide whether a resolved remote recovery shell may be adopted.
 *
 * Extracted as a pure function because the three conditions fail INDEPENDENTLY
 * and only one of them is reachable in an e2e happy path, so inlining it in the
 * async continuation left the teardown races unverifiable. Adopting into a dead
 * session would resurrect a pty that nothing owns and strand the exit report.
 */
export function decideRecoveryAdoption(ctx: RecoveryAdoptionContext): RecoveryAdoption {
  if (ctx.finalized) return { action: 'discard', finalize: false }
  if (ctx.sessionReplaced || ctx.isShuttingDown) return { action: 'discard', finalize: true }
  return { action: 'adopt' }
}
