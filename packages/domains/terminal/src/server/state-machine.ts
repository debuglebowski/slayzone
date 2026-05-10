import type { TerminalState } from '@slayzone/terminal/shared'
import type { ActivityState } from './adapters/types'

/** Callback invoked when state actually changes (after debounce) */
export type StateChangeCallback = (sessionId: string, newState: TerminalState, oldState: TerminalState) => void

const DEBOUNCE_DEFAULT = 100

interface SessionState {
  state: TerminalState
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

  constructor(onChange: StateChangeCallback) {
    this.onChange = onChange
  }

  register(sessionId: string, initialState: TerminalState): void {
    this.sessions.set(sessionId, { state: initialState })
  }

  unregister(sessionId: string): void {
    this.clearTimer(sessionId)
    this.sessions.delete(sessionId)
  }

  getState(sessionId: string): TerminalState | undefined {
    return this.sessions.get(sessionId)?.state
  }

  transition(sessionId: string, newState: TerminalState): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.clearTimer(sessionId)

    if (session.state === newState) return

    if (newState === 'running') {
      const oldState = session.state
      session.state = newState
      this.onChange(sessionId, newState, oldState)
    } else {
      this.timers.set(sessionId, setTimeout(() => {
        this.timers.delete(sessionId)
        const session = this.sessions.get(sessionId)
        if (!session || session.state === newState) return
        const oldState = session.state
        session.state = newState
        this.onChange(sessionId, newState, oldState)
      }, DEBOUNCE_DEFAULT))
    }
  }

  setState(sessionId: string, state: TerminalState): void {
    const session = this.sessions.get(sessionId)
    if (session) session.state = state
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.sessions.clear()
  }

  private clearTimer(sessionId: string): void {
    const pending = this.timers.get(sessionId)
    if (pending) {
      clearTimeout(pending)
      this.timers.delete(sessionId)
    }
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
 */
export function shouldFlipToRunningOnInput(
  adapter: { transitionOnInput?: boolean },
  state: TerminalState,
  inputBufferTrimmedLength: number
): boolean {
  return (
    adapter.transitionOnInput !== false &&
    inputBufferTrimmedLength > 0 &&
    state !== 'running'
  )
}
