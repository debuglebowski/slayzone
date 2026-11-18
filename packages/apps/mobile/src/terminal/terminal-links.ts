/**
 * The web link under a terminal cell — what a tap on the phone's terminal opens.
 * Desktop finds links with the same pattern (`URL_REGEX`, `@slayzone/terminal-contracts`)
 * as the mouse hovers; the phone has no hover, so it looks at the tapped cell. A link
 * the terminal wrapped onto the next lines is joined back first.
 */
import { URL_REGEX } from '@slayzone/terminal-contracts'

/** One buffer line, as xterm's `buffer.active.getLine` gives it. */
export interface BufferLineLike {
  isWrapped: boolean
  translateToString(trimRight?: boolean): string
}

/** Lines a soft-wrapped line is continued over, at most (desktop's 2048-char cap). */
const MAX_WRAPPED_LINES = 32

/**
 * The web link at column `col` (0-based) of buffer line `y`, or null. Columns map to
 * string indexes 1:1 — exact for single-width text, which links are.
 */
export function urlAtCell(
  getLine: (y: number) => BufferLineLike | undefined,
  y: number,
  col: number
): string | null {
  const line = getLine(y)
  if (!line) return null
  let top = y
  while (top > 0 && y - top < MAX_WRAPPED_LINES && getLine(top)?.isWrapped) top--
  const parts: string[] = []
  let at = 0
  for (let i = top; i - top < MAX_WRAPPED_LINES * 2; i++) {
    const current = getLine(i)
    if (!current || (i > top && !current.isWrapped)) break
    if (i === y) at = parts.join('').length + col
    parts.push(current.translateToString(false))
  }
  const text = parts.join('')
  const pattern = new RegExp(URL_REGEX.source, 'g')
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (at >= match.index && at < match.index + match[0].length) return match[0]
  }
  return null
}
