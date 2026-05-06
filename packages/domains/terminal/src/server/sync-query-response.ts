// Pure logic for answering timing-critical terminal queries that the PTY
// onData handler must reply to synchronously. Extracted from pty-manager
// so the logic can be unit-tested without pulling in Electron.
//
// CPR/DA/DSR must be answered before the program proceeds to readline mode.
// An async renderer round-trip would arrive too late — the response bytes
// would then appear as garbage text in the user's prompt.
//
// OSC color queries (10/11/12) are answered from the caller-supplied theme.
// OSC 4 palette queries use xterm defaults for indices 0-15. Any remaining
// OSC query gets an empty body reply so programs don't hang waiting on a
// response (Bun-compiled CLIs like Factory.ai droid fail with an opaque
// "unknown error" when queries go unanswered).

export interface TerminalTheme {
  foreground: string
  background: string
  cursor: string
  /**
   * ANSI palette colors indexed 0-15 (black, red, green, yellow, blue, magenta,
   * cyan, white, then bright variants). Populated by the renderer from xterm.js
   * so OSC 4 palette queries return what is actually displayed. Falls back to
   * xterm defaults when absent.
   */
  ansi?: readonly string[]
}

// xterm default ANSI palette (indices 0-15) used when the renderer has not
// supplied an explicit palette yet.
export const XTERM_ANSI_PALETTE: readonly string[] = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff'
]

export function hexToOscRgb(hex: string): string {
  const r = hex.slice(1, 3)
  const g = hex.slice(3, 5)
  const b = hex.slice(5, 7)
  return `rgb:${r}${r}/${g}${g}/${b}${b}`
}

export interface SyncQueryResult {
  response: string
  forwarded: string
  pendingPartial: string
}

export function computeSyncQueryResponse(input: string, theme: TerminalTheme): SyncQueryResult {
  let response = ''
  let forwarded = input

  // DA1 — Primary Device Attributes
  forwarded = forwarded.replace(/\x1b\[0?c/g, () => { response += '\x1b[?62;4;22c'; return '' })
  // DA2 — Secondary Device Attributes
  forwarded = forwarded.replace(/\x1b\[>0?c/g, () => { response += '\x1b[>0;10;1c'; return '' })
  // DSR — Device Status Report
  forwarded = forwarded.replace(/\x1b\[5n/g, () => { response += '\x1b[0n'; return '' })
  // CPR — Cursor Position. Respond with row=1 col=1. Programs (readline) use CPR mainly
  // to check if the cursor is at col=1 before drawing a prompt. In practice the terminal
  // is at col=1 at this point (startup output ends with a newline).
  forwarded = forwarded.replace(/\x1b\[6n/g, () => { response += '\x1b[1;1R'; return '' })

  // OSC 10/11/12 — Foreground / Background / Cursor color queries.
  forwarded = forwarded.replace(/\x1b\]10;\?(?:\x07|\x1b\\)/g, () => {
    response += `\x1b]10;${hexToOscRgb(theme.foreground)}\x07`
    return ''
  })
  forwarded = forwarded.replace(/\x1b\]11;\?(?:\x07|\x1b\\)/g, () => {
    response += `\x1b]11;${hexToOscRgb(theme.background)}\x07`
    return ''
  })
  forwarded = forwarded.replace(/\x1b\]12;\?(?:\x07|\x1b\\)/g, () => {
    response += `\x1b]12;${hexToOscRgb(theme.cursor)}\x07`
    return ''
  })

  // OSC 4 — ANSI palette query. Answer from the renderer-supplied palette so
  // programs see what is actually displayed. Falls back to xterm defaults when
  // the renderer has not provided a palette yet. Indices outside 0-15 fall
  // through to the catch-all empty reply below.
  forwarded = forwarded.replace(/\x1b\]4;(\d+);\?(?:\x07|\x1b\\)/g, (match, idxRaw) => {
    const idx = parseInt(idxRaw, 10)
    const hex = theme.ansi?.[idx] ?? XTERM_ANSI_PALETTE[idx]
    if (!hex) return match
    response += `\x1b]4;${idx};${hexToOscRgb(hex)}\x07`
    return ''
  })

  // Catch-all — any remaining OSC query ESC ] N ; <body> ? <ST> gets an empty
  // reply ESC ] N ; <ST> so the program stops waiting. Previously these were
  // silently stripped, which hung Bun-compiled CLIs and some Node TUIs.
  forwarded = forwarded.replace(/\x1b\](\d+);[^\x07\x1b]*\?(?:\x07|\x1b\\)/g, (_, n) => {
    response += `\x1b]${n};\x07`
    return ''
  })

  // Trailing incomplete OSC or CSI sequence that may complete in the next chunk.
  // OSC: ESC ] <body> — body ends with BEL or ST (ESC \). Trailing ESC alone could be ST start.
  // CSI: ESC [ <params> — ends with a letter in range @–~.
  const partial = forwarded.match(/\x1b(?:\][^\x07\x1b]*\x1b?|\[[0-9;:>]*)?$/)
  let pendingPartial = ''
  if (partial?.[0]) {
    pendingPartial = partial[0]
    forwarded = forwarded.slice(0, -partial[0].length)
  }

  return { response, forwarded, pendingPartial }
}
