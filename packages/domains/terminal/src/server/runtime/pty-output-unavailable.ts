/**
 * The session's scrollback lives on its computer, which is unreachable right now.
 * The process may still be running; nothing is lost — it is readable again when the
 * computer reconnects (`output-availability` → true). Clients show it as offline.
 */
export class PtyOutputUnavailableError extends Error {
  readonly code = 'COMPUTER_OFFLINE'
  constructor(sessionId: string, cause?: unknown) {
    super(`The computer running terminal ${sessionId} is offline`, { cause })
    this.name = 'PtyOutputUnavailableError'
  }
}
