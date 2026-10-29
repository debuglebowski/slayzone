/** The task a terminal session belongs to: session ids are `<taskId>:<tabId>`. */
export function taskIdFromSessionId(sessionId: string): string {
  const idx = sessionId.indexOf(':')
  return idx >= 0 ? sessionId.substring(0, idx) : sessionId
}
