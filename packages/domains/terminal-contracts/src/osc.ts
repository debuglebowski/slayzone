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
