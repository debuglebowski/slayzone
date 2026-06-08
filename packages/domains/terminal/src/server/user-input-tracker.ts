/**
 * Tracks which PTY/chat sessions have received real user input (a submitted
 * prompt or stdin line). Drives `needs_attention`: a `running → idle` transition
 * only flags the task when the user has actually initiated a turn — not when
 * the agent finishes its initial boot/banner on auto-spawn after task open.
 *
 * Keys are broadcast-format session ids: `${taskId}` or `${taskId}:${tabId}`.
 * Cleared on session destroy. In-memory only — fresh start after app restart
 * is intentional (no expected attention until the next user turn).
 */
const sessionsWithUserInput = new Set<string>()

export function markSessionUserInput(sessionId: string): void {
  sessionsWithUserInput.add(sessionId)
}

export function clearSessionUserInputMark(sessionId: string): void {
  sessionsWithUserInput.delete(sessionId)
}

export function hasSessionUserInput(sessionId: string): boolean {
  return sessionsWithUserInput.has(sessionId)
}
