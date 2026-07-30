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
  '#000000',
  '#cd0000',
  '#00cd00',
  '#cdcd00',
  '#0000ee',
  '#cd00cd',
  '#00cdcd',
  '#e5e5e5',
  '#7f7f7f',
  '#ff0000',
  '#00ff00',
  '#ffff00',
  '#5c5cff',
  '#ff00ff',
  '#00ffff',
  '#ffffff'
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

/**
 * Longest trailing partial sequence worth holding for the next chunk.
 *
 * The CSI branch of the hold pattern self-bounds — its parameter class breaks on
 * any text byte — but the OSC branch's `[^\x07\x1b]*` matches everything that is
 * not BEL or ESC. Without a cap, a chunk that happens to end inside an OSC body
 * holds unboundedly and NOTHING is forwarded: the terminal appears frozen (not
 * scrambled) until some later ESC releases it, which a resize supplies via the
 * SIGWINCH redraw.
 *
 * 32 covers every query we answer — the longest is `ESC]4;255;?BEL` at 14 bytes —
 * so capping costs nothing. Past the cap we forward verbatim, which is already
 * the behaviour for unrecognised sequences: the bytes stay contiguous and the
 * terminal's own parser reassembles them. The only capability given up is
 * answering a query torn open past 32 bytes, which cannot occur.
 *
 * Mirrors `MAX_HELD_TAIL` in `@slayzone/platform`'s device-status stripper, which
 * has always capped its equivalent hold.
 */
const MAX_HELD_PARTIAL = 32

export function computeSyncQueryResponse(input: string, theme: TerminalTheme): SyncQueryResult {
  let response = ''
  let forwarded = input

  // DA1 — Primary Device Attributes
  forwarded = forwarded.replace(/\x1b\[0?c/g, () => {
    response += '\x1b[?62;4;22c'
    return ''
  })
  // DA2 — Secondary Device Attributes
  forwarded = forwarded.replace(/\x1b\[>0?c/g, () => {
    response += '\x1b[>0;10;1c'
    return ''
  })
  // DSR — Device Status Report
  forwarded = forwarded.replace(/\x1b\[5n/g, () => {
    response += '\x1b[0n'
    return ''
  })
  // CPR — Cursor Position. Respond with row=1 col=1. Programs (readline) use CPR mainly
  // to check if the cursor is at col=1 before drawing a prompt. In practice the terminal
  // is at col=1 at this point (startup output ends with a newline).
  forwarded = forwarded.replace(/\x1b\[6n/g, () => {
    response += '\x1b[1;1R'
    return ''
  })

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
  //
  // OSC 0/1/2 are EXCLUDED: they set the window/icon title, whose body is free
  // text, so a title merely ending in `?` ("build ok?") matched this pattern —
  // deleting the title from the output AND injecting a bogus `ESC]0;BEL` into the
  // program's stdin as though the user had typed it. They are never queries, and
  // `filterBufferData` already strips them from the replay buffer.
  //
  // OSC 52 deliberately stays in scope: `ESC]52;c;?BEL` is a real clipboard READ
  // and an empty reply is the valid "nothing available" answer.
  forwarded = forwarded.replace(/\x1b\](\d+);[^\x07\x1b]*\?(?:\x07|\x1b\\)/g, (match, n) => {
    if (n === '0' || n === '1' || n === '2') return match
    response += `\x1b]${n};\x07`
    return ''
  })

  // Trailing incomplete OSC or CSI sequence that may complete in the next chunk.
  // OSC: ESC ] <body> — body ends with BEL or ST (ESC \). Trailing ESC alone could be ST start.
  // CSI: ESC [ <params> — ends with a letter in range @–~.
  //
  // The CSI param class MUST include `?` (DEC private introducer) alongside `>`
  // and `<`. Without it, a chunk ending `ESC [ ? 6` is forwarded verbatim and its
  // `n` arrives orphaned next chunk: the split query is invisible to the answerer
  // here AND to the per-chunk `filterBufferData` strip, so it reaches the replay
  // buffer, where a later replay makes xterm.js answer it — the row=1 answer Claude
  // Code reads as "screen externally wiped" → `/clear`. Any private-mode sequence
  // split on that boundary had the same corruption risk; this covers the class.
  const partial = forwarded.match(/\x1b(?:\][^\x07\x1b]*\x1b?|\[[?<>0-9;:]*)?$/)
  let pendingPartial = ''
  if (partial?.[0] && partial[0].length <= MAX_HELD_PARTIAL) {
    pendingPartial = partial[0]
    forwarded = forwarded.slice(0, -partial[0].length)
  }

  return { response, forwarded, pendingPartial }
}
