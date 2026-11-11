import type { TerminalState } from '@slayzone/terminal-contracts'

/** One live agent session as a host lists it — a PTY (`listPtys`) or a chat
 *  (the chat relay's sessions, `not-spawned` skeletons included). */
export interface TaskAgentSessionEntry {
  sessionId: string
  taskId: string
  state: TerminalState | 'not-spawned'
}

/**
 * "Mid-reply": the agent is producing a turn right now. Idle (turn finished,
 * waiting for input), `background` (turn finished, only background jobs left),
 * `starting`, and exited sessions are not. The CLI refuses to complete a task
 * with an agent in this state unless `--force` — completion stops every agent.
 */
export function isMidReplyState(state: TerminalState | 'not-spawned'): boolean {
  return state === 'running'
}

/** Session ids of `taskId`'s agents that are mid-reply. */
export function midReplySessionIds(
  taskId: string,
  sessions: Iterable<TaskAgentSessionEntry>
): string[] {
  const out: string[] = []
  for (const s of sessions) {
    if (s.taskId === taskId && isMidReplyState(s.state)) out.push(s.sessionId)
  }
  return out
}
