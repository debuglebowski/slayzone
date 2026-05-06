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

/** Map ActivityState to TerminalState */
export function activityToTerminalState(activity: ActivityState): TerminalState | null {
  switch (activity) {
    case 'working':
      return 'running'
    default:
      return null
  }
}
