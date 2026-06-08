/**
 * Gate for adapter-detected terminal errors.
 *
 * A `claude --resume <id>` against a conversation Claude no longer has prints
 * "No conversation found with session ID:" and produces no distinct exit signal,
 * so `ClaudeAdapter.detectError` matches that literal string to surface a
 * SESSION_NOT_FOUND error. The hazard: that exact string also appears in normal
 * agent output (e.g. an agent writing about this very bug — which is how task
 * 753 froze itself). A mid-session echo of the string is a FALSE POSITIVE that
 * must not flip the session to 'error' (and, on a resume, set `suppressOutput`).
 *
 * SESSION_NOT_FOUND is therefore only valid during the resume startup window
 * (`checkingForSessionError`, which auto-closes a few seconds after spawn). After
 * the window closes, a match is an echo and is ignored. Other error codes are not
 * string-echo-prone, so they are always honored.
 */
export function shouldHonorDetectedError(
  code: string,
  checkingForSessionError: boolean
): boolean {
  if (code === 'SESSION_NOT_FOUND') return checkingForSessionError === true
  return true
}
