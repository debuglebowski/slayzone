import type { TerminalState } from './types'

/**
 * What a UI calls each agent state — desktop's status dots and the phone's agent
 * list say the same words. Desktop's dot styles (`@slayzone/ui` terminal-state.ts,
 * which cannot import a domain) carry their own copy; `@slayzone/terminal`'s
 * terminal-state-labels.test.ts pins the two equal.
 */
export const TERMINAL_STATE_LABELS: Readonly<Record<TerminalState, string>> = {
  starting: 'Starting',
  running: 'Active',
  // The main agent's turn is done; only its background subagents still work.
  background: 'Subagents working',
  idle: 'Idle',
  error: 'Error',
  dead: 'Stopped',
  // Idle-closed to free memory; reopening resumes it.
  hibernated: 'Paused'
}

/** A task whose agent finished a turn the user has not looked at (`needs_attention`). */
export const UNREAD_LABEL = 'Unread'
