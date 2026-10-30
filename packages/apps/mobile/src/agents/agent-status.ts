/**
 * How the app sorts agents for the user: which group an agent is in (what it needs
 * from them), and what its state is called. A pure function of two hub facts:
 *
 * - the session's `TerminalState` (`pty.sessionList` / `pty.onStateChange`, the
 *   shared terminal-state rules), and
 * - the task's `needs_attention` (unread): the hub sets it when a turn the user
 *   started ends (`running|background → idle|error`, `@slayzone/task` attention.ts),
 *   clears it when work resumes, and a client clears it when the user opens the task.
 *
 * The hub reports a finished turn and an agent blocked on a question the same way
 * (both `idle`, both unread), so they are one group, "Waiting for you". Labels are
 * desktop's words (`TERMINAL_STATE_LABELS`, pinned equal to desktop's dots).
 */
import { TERMINAL_STATE_LABELS, type TerminalState } from '@slayzone/terminal-contracts'

export type AgentGroup = 'waiting' | 'error' | 'running' | 'hibernated' | 'done'

/** What needs the user first. */
export const AGENT_GROUP_ORDER: readonly AgentGroup[] = [
  'waiting',
  'error',
  'running',
  'hibernated',
  'done'
]

export const AGENT_GROUP_TITLES: Readonly<Record<AgentGroup, string>> = {
  waiting: 'Waiting for you',
  error: 'Error',
  running: 'Running',
  hibernated: 'Paused',
  done: 'Done'
}

export function agentGroup(state: TerminalState, needsAttention: boolean): AgentGroup {
  switch (state) {
    case 'starting':
    case 'running':
    case 'background':
      return 'running'
    case 'idle':
      return needsAttention ? 'waiting' : 'done'
    case 'error':
      return 'error'
    case 'hibernated':
      return 'hibernated'
    case 'dead':
      return 'done'
  }
}

export function agentStateLabel(state: TerminalState): string {
  return TERMINAL_STATE_LABELS[state]
}
