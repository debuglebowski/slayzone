import type { TerminalState } from '@slayzone/terminal/shared'
import type { ActivityState } from './adapters/types'

/** Callback invoked when state actually changes (after debounce) */
export type StateChangeCallback = (
  sessionId: string,
  newState: TerminalState,
  oldState: TerminalState
) => void

/** Diagnostic trace of every transition decision the machine makes.
 *  Pure observation — must not influence state. Optional so production paths
 *  with no logger attached pay zero overhead. */
export type StateTraceCallback = (event: StateTraceEvent) => void

export type StateTraceEvent =
  | { kind: 'request'; sessionId: string; fromState: TerminalState; toState: TerminalState; hadPending: TerminalState | null }
  | { kind: 'skipped_same'; sessionId: string; state: TerminalState }
  | { kind: 'immediate'; sessionId: string; fromState: TerminalState; toState: TerminalState }
  | { kind: 'queued'; sessionId: string; fromState: TerminalState; toState: TerminalState; debounceMs: number }
  | { kind: 'canceled'; sessionId: string; canceledTarget: TerminalState; reason: 'new_request' | 'unregister' | 'dispose' }
  | { kind: 'fired'; sessionId: string; fromState: TerminalState; toState: TerminalState }

const DEBOUNCE_DEFAULT = 100

interface SessionState {
  state: TerminalState
  /** Target the pending debounce timer will apply when it fires. null if no timer. */
  pendingTarget: TerminalState | null
}

/**
 * Manages terminal state transitions with debouncing.
 * - Transitions to 'running' are immediate (show work resuming right away)
 * - Other transitions debounce 100ms (coalesce rapid bursts)
 *
 * No Electron dependencies — pure logic, testable with fake timers.
 */
export class StateMachine {
  private sessions = new Map<string, SessionState>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private onChange: StateChangeCallback
  private onTrace: StateTraceCallback | undefined

  constructor(onChange: StateChangeCallback, onTrace?: StateTraceCallback) {
    this.onChange = onChange
    this.onTrace = onTrace
  }

  register(sessionId: string, initialState: TerminalState): void {
    this.sessions.set(sessionId, { state: initialState, pendingTarget: null })
  }

  unregister(sessionId: string): void {
    const pending = this.sessions.get(sessionId)?.pendingTarget ?? null
    this.clearTimer(sessionId)
    if (pending) this.onTrace?.({ kind: 'canceled', sessionId, canceledTarget: pending, reason: 'unregister' })
    this.sessions.delete(sessionId)
  }

  getState(sessionId: string): TerminalState | undefined {
    return this.sessions.get(sessionId)?.state
  }

  transition(sessionId: string, newState: TerminalState): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const hadPending = session.pendingTarget
    this.onTrace?.({ kind: 'request', sessionId, fromState: session.state, toState: newState, hadPending })

    if (hadPending) {
      this.clearTimer(sessionId)
      this.onTrace?.({ kind: 'canceled', sessionId, canceledTarget: hadPending, reason: 'new_request' })
    }

    if (session.state === newState) {
      this.onTrace?.({ kind: 'skipped_same', sessionId, state: session.state })
      return
    }

    if (newState === 'running') {
      const oldState = session.state
      session.state = newState
      this.onTrace?.({ kind: 'immediate', sessionId, fromState: oldState, toState: newState })
      this.onChange(sessionId, newState, oldState)
    } else {
      session.pendingTarget = newState
      this.onTrace?.({ kind: 'queued', sessionId, fromState: session.state, toState: newState, debounceMs: DEBOUNCE_DEFAULT })
      this.timers.set(
        sessionId,
        setTimeout(() => {
          this.timers.delete(sessionId)
          const session = this.sessions.get(sessionId)
          if (!session) return
          session.pendingTarget = null
          if (session.state === newState) {
            this.onTrace?.({ kind: 'skipped_same', sessionId, state: session.state })
            return
          }
          const oldState = session.state
          session.state = newState
          this.onTrace?.({ kind: 'fired', sessionId, fromState: oldState, toState: newState })
          this.onChange(sessionId, newState, oldState)
        }, DEBOUNCE_DEFAULT)
      )
    }
  }

  setState(sessionId: string, state: TerminalState): void {
    const session = this.sessions.get(sessionId)
    if (session) session.state = state
  }

  dispose(): void {
    for (const [sessionId, timer] of this.timers.entries()) {
      clearTimeout(timer)
      const pending = this.sessions.get(sessionId)?.pendingTarget ?? null
      if (pending) this.onTrace?.({ kind: 'canceled', sessionId, canceledTarget: pending, reason: 'dispose' })
    }
    this.timers.clear()
    this.sessions.clear()
  }

  private clearTimer(sessionId: string): void {
    const pending = this.timers.get(sessionId)
    if (pending) {
      clearTimeout(pending)
      this.timers.delete(sessionId)
    }
    const session = this.sessions.get(sessionId)
    if (session) session.pendingTarget = null
  }
}

/** Map ActivityState to TerminalState. `'idle'` is an explicit done-signal
 *  some adapters emit (e.g. claude completion stamp) to flip running→idle
 *  immediately rather than waiting for the silence timer. */
export function activityToTerminalState(activity: ActivityState): TerminalState | null {
  switch (activity) {
    case 'working':
      return 'running'
    case 'idle':
      return 'idle'
    default:
      return null
  }
}

/**
 * Should an output chunk refresh `lastOutputTime` (the idle clock)?
 *
 * - TUI adapter (default, `transitionOnInput !== false`): refresh ONLY on
 *   detected `'working'` — raw redraws and explicit `'idle'` signals must
 *   not pin the clock open. Keeping the clock un-refreshed on `'idle'` lets
 *   the silence-timer fallback stay primed in case the active signal is
 *   missed by a later chunk.
 * - Output-driven adapter (`transitionOnInput === false`, e.g. plain shell):
 *   refresh on every chunk so a tail-style stream stays "active".
 */
export function shouldRefreshIdleClock(
  adapter: { transitionOnInput?: boolean },
  detectedActivity: ActivityState | null
): boolean {
  return adapter.transitionOnInput === false || detectedActivity === 'working'
}

/**
 * Should the inactivity checker flip a session 'running' → 'idle' right now?
 * Pure: true iff the session is running and has been silent past its timeout.
 */
export function shouldFlipToIdle(
  state: TerminalState,
  lastOutputTime: number,
  now: number,
  idleTimeoutMs: number
): boolean {
  return state === 'running' && now - lastOutputTime >= idleTimeoutMs
}

/**
 * Should pressing Enter auto-flip a session to 'running'?
 * TUI adapters (default) want this so the spinner state is reflected
 * immediately; plain shell opts out to avoid spurious "running" on commands.
 * Hook-driven adapters opt out too: their 'running' comes from the hook, and
 * with no silence-timer (idleTimeoutMs=Infinity) there is nothing to undo a
 * flip that a local slash command (/status) never confirms → stuck-running.
 */
export function shouldFlipToRunningOnInput(
  adapter: { transitionOnInput?: boolean; hookDriven?: boolean },
  state: TerminalState,
  inputBufferTrimmedLength: number
): boolean {
  if (adapter.hookDriven) return false
  return adapter.transitionOnInput !== false && inputBufferTrimmedLength > 0 && state !== 'running'
}

/**
 * Multi-chunk gate for adapter-driven `idle → running` promotion.
 *
 * A single output chunk can falsely match an adapter's `'working'` heuristic
 * — e.g. a TUI chrome redraw line that happens to start with a Claude bullet
 * glyph but is not actually a live spinner. Promoting on that single chunk +
 * the silence timer then producing a `running → idle` flip a few seconds
 * later is the mechanism behind spurious `needs_attention` notifications.
 *
 * Require `≥ threshold` `'working'` detections inside `windowMs`: real
 * spinners emit many chunks per second; one-off chrome redraws do not. The
 * `'idle'` completion-stamp signal bypasses this gate (strong active done-
 * signal), as does the user-input flip path.
 *
 * Pure: returns the trimmed history (with `now` appended) and whether the
 * caller should fire the transition. Caller is responsible for resetting the
 * history on promote.
 */
export const WORKING_DETECTION_WINDOW_MS = 1500
export const WORKING_DETECTION_THRESHOLD = 2

export function recordWorkingDetection(
  prev: number[] | undefined,
  now: number,
  windowMs: number = WORKING_DETECTION_WINDOW_MS,
  threshold: number = WORKING_DETECTION_THRESHOLD
): { history: number[]; shouldPromote: boolean } {
  const recent = (prev ?? []).filter((t) => now - t < windowMs)
  recent.push(now)
  return {
    history: recent,
    shouldPromote: recent.length >= threshold
  }
}
