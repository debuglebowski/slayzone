// Extract terminal title from OSC 0/1/2 sequences (e.g. \x1b]0;title\x07)
// Returns the last title found, or undefined if none.
export function extractOscTitle(data: string): string | undefined {
  let title: string | undefined
  const re = /\x1b\]([012]);([^\x07\x1b]*)(?:\x07|\x1b\\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(data)) !== null) {
    title = m[2]
  }
  return title
}

/**
 * Drop OSC strings (`ESC ] … BEL` / `ESC ] … ESC \`) from bytes a client is about to
 * write to a pty. In that direction they are only ever a terminal's ANSWERS to colour
 * queries, never user input — and the server is the sole authority for answering
 * (synchronously, `computeSyncQueryResponse`): a client's answer is stale by
 * construction and lands as escape bytes in the program's stdin (it broke gh CLI's
 * interactive prompts). Everything else — keystrokes, CSI keys — passes unchanged.
 */
export function stripOscReplies(data: string): string {
  return data.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
}
