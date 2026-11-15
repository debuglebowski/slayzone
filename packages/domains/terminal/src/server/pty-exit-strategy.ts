/**
 * Pure decision logic for PTY exit handling.
 * Extracted from pty-manager to enable unit testing.
 */

export interface ExitContext {
  exitCode: number
  agentId: string
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
export function buildRecoveryMessage(agentId: string, exitCode: number): string {
  return `\r\n[SlayZone] ${agentId} exited with code ${String(exitCode)}. Switched to interactive shell for recovery.\r\n`
}

/**
 * How long an agent must have run since its FIRST OUTPUT before a death counts as
 * "mid-session" rather than a start failure. A start failure (bad flag, auth error,
 * stale resume) prints and exits within seconds, and its recovery shell is the right
 * answer: the user needs to see and fix the cause, and a resume would only fail again.
 */
export const AUTO_RESUME_MIN_UPTIME_MS = 10_000
/** At most one auto-resume per session in this window; a second death in it gets the
 *  recovery shell — an agent that keeps dying must not be restarted in a loop. */
export const AUTO_RESUME_WINDOW_MS = 5 * 60_000
/** A ^C / ^D the user typed this recently explains the death: they ended it. */
export const USER_INTERRUPT_GRACE_MS = 10_000
/** The conventional exit code of a process ended by SIGINT (128 + 2): the user's ^C. */
export const SIGINT_EXIT_CODE = 130

/** What is known when an agent's process has exited. */
export interface UnexpectedExitContext {
  exitCode: number
  /** The killing signal, when the owner reported one (0 / absent = none). */
  signal?: number
  /** Lifecycle cause the backend attached (`startup-timeout`, a transport outcome). */
  reason?: string
  hasPostSpawnCommand: boolean
  usedShellFallback: boolean
  /** A stale / in-use resume: its own overlay explains it. */
  isStale: boolean
  /** The mode has a `resumeCommand`. */
  hasResumeCommand: boolean
  /** The provider's resume faithfully restores a conversation (see hibernation). */
  resumeEligibleMode: boolean
  /** The conversation the session is on, if known. */
  conversationId: string | null
  /** SlayZone asked for this death: `killPty` (close, restart, task done, hand-off). */
  killRequested: boolean
  /** App quit (`shutdownAllPtys`). */
  shuttingDown: boolean
  /** Idle hibernation killed it. */
  hibernating: boolean
  /** Epoch ms of the session's first output; null = it never printed. */
  firstOutputAt: number | null
  /** Epoch ms the user last typed ^C / ^D into it. */
  lastInterruptInputAt: number | null
  /** Epoch ms of this session's last auto-resume. */
  lastAutoResumeAt: number | null
  now: number
}

/** Why an exit is left to the existing path (recovery shell / overlay / plain exit). */
export type UnexpectedExitSkip =
  | 'clean-exit'
  | 'not-agent'
  | 'recovery-shell'
  | 'stale'
  | 'requested'
  | 'transport'
  | 'user-interrupt'
  | 'startup'
  | 'no-resume'
  | 'no-conversation'

export type UnexpectedExitDecision =
  /** Restart the agent on its conversation, in place. */
  | { action: 'resume' }
  /** It would resume, but this session already auto-resumed within the window. */
  | { action: 'rate-limited' }
  /** Not an unexpected mid-session death: the existing exit path decides. */
  | { action: 'none'; why: UnexpectedExitSkip }

/**
 * Did an agent die mid-session in a way nobody asked for — and can it be resumed?
 *
 * Only then is the agent restarted on the same conversation (its provider's
 * `resumeCommand`). Every other exit keeps today's handling: a start failure gets
 * the recovery shell, a stale resume its overlay, a requested kill ends the session.
 */
export function decideUnexpectedExit(ctx: UnexpectedExitContext): UnexpectedExitDecision {
  const none = (why: UnexpectedExitSkip): UnexpectedExitDecision => ({ action: 'none', why })
  if (ctx.exitCode === 0 && !ctx.signal) return none('clean-exit')
  if (!ctx.hasPostSpawnCommand) return none('not-agent')
  if (ctx.usedShellFallback) return none('recovery-shell')
  if (ctx.isStale) return none('stale')
  if (ctx.killRequested || ctx.shuttingDown || ctx.hibernating) return none('requested')
  if (ctx.reason) return none('transport')
  if (
    ctx.exitCode === SIGINT_EXIT_CODE ||
    (ctx.lastInterruptInputAt !== null &&
      ctx.now - ctx.lastInterruptInputAt < USER_INTERRUPT_GRACE_MS)
  )
    return none('user-interrupt')
  if (ctx.firstOutputAt === null || ctx.now - ctx.firstOutputAt < AUTO_RESUME_MIN_UPTIME_MS)
    return none('startup')
  if (!ctx.hasResumeCommand || !ctx.resumeEligibleMode) return none('no-resume')
  if (!ctx.conversationId) return none('no-conversation')
  if (ctx.lastAutoResumeAt !== null && ctx.now - ctx.lastAutoResumeAt < AUTO_RESUME_WINDOW_MS)
    return { action: 'rate-limited' }
  return { action: 'resume' }
}

/** The line shown in the terminal when an agent is resumed after an unexpected exit. */
export function buildAutoResumeMessage(agentId: string, exitCode: number, signal?: number): string {
  const how = signal ? `signal ${String(signal)}` : `code ${String(exitCode)}`
  return `\r\n[SlayZone] ${agentId} exited unexpectedly (${how}) — resuming conversation.\r\n`
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
