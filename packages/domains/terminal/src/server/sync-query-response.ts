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

/**
 * Version xterm.js reports for XTVERSION. Pinned rather than imported: this
 * module is pure logic with no module-resolution or Node dependencies (it is
 * bundled into the sidecar and the hub). `sync-query-response.test.ts` resolves
 * `@xterm/xterm/package.json` and fails loudly if the two drift.
 */
export const XTERM_JS_VERSION = '6.1.0-beta.304'

/**
 * XTVERSION reply — byte-identical to what xterm.js's `sendXtVersion` emits.
 *
 * Answered HERE, by the server, rather than left to round-trip to the renderer.
 * Leaving it to xterm.js broke interactive agents two ways at once:
 *
 *  1. The reply travelled back over the async onData path, so it could land in
 *     the program's stdin long after the program had moved on — the same
 *     "stale by construction" hazard CPR/DSR are answered here to avoid.
 *  2. Worse, an unanswered query is not stripped, so it survived into the
 *     replayable ring buffer. Every mount/reattach/renderer-reload replayed it
 *     and xterm answered AGAIN — this time completely unsolicited.
 *
 * Either way a DCS lands in stdin unbidden, and Claude Code's key handling
 * wedges on it: keystrokes still reach the process and drive nothing, while
 * output keeps rendering (a SIGWINCH repaint still paints a full frame). Only a
 * session restart clears it. Reproduced by injecting this exact reply into a
 * healthy session — arrows died on the very next keypress.
 *
 * Answering synchronously fixes both: the program reads the same bytes it always
 * did, in the same read-loop iteration it asked, and the query never reaches the
 * buffer to be replayed.
 */
export const XTVERSION_RESPONSE = `\x1bP>|xterm.js(${XTERM_JS_VERSION})\x1b\\`

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

/**
 * One piece of a chunk, in stream order.
 *
 * - `output` — ordinary program output: forwarded to clients AND fed to the
 *   session's terminal mirror so its state tracks the screen.
 * - `reply` — the answer to a STATELESS query (DA, XTVERSION, DSR, OSC colors),
 *   computed here; the query itself is stripped.
 * - `mirror-query` — a query whose answer depends on terminal STATE (cursor
 *   position, mode settings, SGR). Stripped from the forwarded output, so no
 *   client answers it, and handed to the mirror, which answers it from the
 *   state it reached at exactly this point in the stream.
 *
 * Consumers must process parts in order — that order IS the reply order.
 */
export type SyncQueryPart =
  | { kind: 'output'; data: string }
  | { kind: 'reply'; data: string }
  | { kind: 'mirror-query'; data: string }

export interface SyncQueryResult {
  parts: SyncQueryPart[]
  /** Every `reply` part joined, in order. */
  response: string
  /** Every `output` part joined, in order — what clients receive. */
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

/**
 * Every query we handle, as ONE alternation so a single left-to-right pass sees
 * them in the order the program sent them. Replies MUST preserve that order, as
 * a real terminal's do: termenv (gh, lipgloss/glamour apps) probes with
 * `OSC 11 ?` followed by `CSI 6n` as a sentinel, and if the CPR reply arrives
 * first it concludes "no OSC support" and stops reading — leaving the OSC reply
 * in stdin, where the next key reader chokes on it (`gh auth login`: "unexpected
 * escape sequence from terminal: ['\x1b' ']']"). One regex pass per query kind
 * emitted replies grouped by kind instead, which is exactly that failure.
 *
 * Groups: 1 = stateless CSI query, 2 = XTVERSION Ps, 3 = OSC number, 4 = OSC
 * body (everything between `N;` and the final `?`), 5 = stateful query for the
 * mirror: CPR (`CSI 6n`), DECRQM (`CSI [?] Ps $ p`), DECRQSS (`DCS $ q Pt ST`).
 *
 * DECXCPR (`CSI ? 6 n`) is deliberately NOT here: it stays forwarded and
 * unanswered (see `TerminalReplyMirror`).
 */
const QUERY_PATTERN =
  /\x1b\[(0?c|>0?c|>(\d*)q|5n)|\x1b\](\d+);([^\x07\x1b]*)\?(?:\x07|\x1b\\)|(\x1b\[6n|\x1b\[\??\d*\$p|\x1bP\$q[^\x07\x1b]*(?:\x07|\x1b\\))/g

function answerCsiQuery(query: string, xtversionPs: string | undefined): string | null {
  // DA1 — Primary Device Attributes
  if (query === 'c' || query === '0c') return '\x1b[?62;4;22c'
  // DA2 — Secondary Device Attributes
  if (query === '>c' || query === '>0c') return '\x1b[>0;10;1c'
  // DSR — Device Status Report
  if (query === '5n') return '\x1b[0n'
  // XTVERSION — CSI > Ps q. xterm.js answers only when Ps is absent or <= 0
  // (`sendXtVersion`); mirror that exactly, or we invent replies to sequences a
  // real terminal stays silent on. Ps > 0 stays forwarded — xterm consumes it
  // without emitting anything, so it is inert in the replay buffer.
  // NOT to be confused with DECSCUSR (`CSI Ps SP q`), which has no `>` prefix.
  if (xtversionPs !== undefined) {
    if (xtversionPs !== '' && parseInt(xtversionPs, 10) > 0) return null
    return XTVERSION_RESPONSE
  }
  return null
}

function answerOscQuery(n: string, body: string, theme: TerminalTheme): string | null {
  // OSC 0/1/2 set the window/icon title, whose body is free text, so a title
  // merely ending in `?` ("build ok?") matches the query shape. They are never
  // queries: answering would delete the title from the output AND inject a bogus
  // `ESC]0;BEL` into the program's stdin as though the user had typed it.
  // `filterBufferData` already strips them from the replay buffer.
  if (n === '0' || n === '1' || n === '2') return null

  // OSC 10/11/12 — Foreground / Background / Cursor color queries.
  if (body === '') {
    if (n === '10') return `\x1b]10;${hexToOscRgb(theme.foreground)}\x07`
    if (n === '11') return `\x1b]11;${hexToOscRgb(theme.background)}\x07`
    if (n === '12') return `\x1b]12;${hexToOscRgb(theme.cursor)}\x07`
  }

  // OSC 4 — ANSI palette query. Answer from the renderer-supplied palette so
  // programs see what is actually displayed. Falls back to xterm defaults when
  // the renderer has not provided a palette yet. Indices outside 0-15 fall
  // through to the catch-all empty reply below.
  if (n === '4') {
    const idxMatch = /^(\d+);$/.exec(body)
    if (idxMatch) {
      const idx = parseInt(idxMatch[1], 10)
      const hex = theme.ansi?.[idx] ?? XTERM_ANSI_PALETTE[idx]
      if (hex) return `\x1b]4;${idx};${hexToOscRgb(hex)}\x07`
    }
  }

  // Catch-all — any remaining OSC query ESC ] N ; <body> ? <ST> gets an empty
  // reply ESC ] N ; <ST> so the program stops waiting. Previously these were
  // silently stripped, which hung Bun-compiled CLIs and some Node TUIs.
  //
  // OSC 52 deliberately stays in scope: `ESC]52;c;?BEL` is a real clipboard READ
  // and an empty reply is the valid "nothing available" answer.
  return `\x1b]${n};\x07`
}

/**
 * Trailing incomplete OSC, DCS or CSI sequence that may complete in the next chunk.
 * OSC/DCS: ESC ] or ESC P <body> — body ends with BEL or ST (ESC \). Trailing ESC
 * alone could be ST start. CSI: ESC [ <params/intermediates> — ends with a letter
 * in range @–~.
 *
 * The CSI class MUST include `?` (DEC private introducer) alongside `>` and `<`.
 * Without it, a chunk ending `ESC [ ? 6` is forwarded verbatim and its `n` arrives
 * orphaned next chunk: the split query is invisible to the answerer here AND to
 * the per-chunk `filterBufferData` strip, so it reaches the replay buffer, where a
 * later replay makes xterm.js answer it — the row=1 answer Claude Code reads as
 * "screen externally wiped" → `/clear`. `$` (DECRQM's intermediate) is in the
 * class for the same reason.
 */
const PARTIAL_TAIL = /\x1b(?:[\]P][^\x07\x1b]*\x1b?|\[[?<>0-9;:$]*)?$/

export function computeSyncQueryResponse(input: string, theme: TerminalTheme): SyncQueryResult {
  const parts: SyncQueryPart[] = []
  let response = ''
  let forwarded = ''
  const pushOutput = (data: string): void => {
    if (!data) return
    const last = parts[parts.length - 1]
    if (last?.kind === 'output') last.data += data
    else parts.push({ kind: 'output', data })
    forwarded += data
  }

  let cursor = 0
  for (const m of input.matchAll(QUERY_PATTERN)) {
    const [match, csi, xtversionPs, oscN, oscBody, mirrorQuery] = m
    const reply =
      mirrorQuery !== undefined
        ? null
        : csi !== undefined
          ? answerCsiQuery(csi, xtversionPs)
          : answerOscQuery(oscN as string, oscBody as string, theme)
    if (mirrorQuery === undefined && reply === null) continue // not ours: stays output
    pushOutput(input.slice(cursor, m.index))
    cursor = m.index + match.length
    if (mirrorQuery !== undefined) {
      parts.push({ kind: 'mirror-query', data: mirrorQuery })
    } else {
      parts.push({ kind: 'reply', data: reply as string })
      response += reply
    }
  }

  let tail = input.slice(cursor)
  let pendingPartial = ''
  const partial = tail.match(PARTIAL_TAIL)
  if (partial?.[0] && partial[0].length <= MAX_HELD_PARTIAL) {
    pendingPartial = partial[0]
    tail = tail.slice(0, -partial[0].length)
  }
  pushOutput(tail)

  return { parts, response, forwarded, pendingPartial }
}
