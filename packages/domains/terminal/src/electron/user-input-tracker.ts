/**
 * Tracks which PTY/chat sessions have received real user input (a submitted
 * prompt or stdin line). Drives `needs_attention`: a `running -> idle`
 * transition only flags the task when the user initiated a turn.
 *
 * Keys are broadcast-format session ids: `${taskId}` or `${taskId}:${tabId}`.
 * Cleared on session destroy. In-memory only by design.
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
