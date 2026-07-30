/**
 * Strip terminal CURSOR-POSITION / STATUS queries and their responses.
 *
 * A query is a question the program asked the terminal ("where is the cursor?").
 * It is answered once, live, by whoever owned the terminal at that moment — for
 * these particular queries that is always the SERVER, synchronously (see
 * `computeSyncQueryResponse`), precisely because an async round-trip through the
 * renderer arrives too late and lands as garbage bytes in the program's stdin.
 *
 * So a cursor-position query has no meaning downstream of the server, and in a
 * replayable buffer it is actively harmful: on replay the bytes reach a real
 * terminal emulator (xterm.js), which dutifully answers every one of them, and
 * those answers are forwarded to the live process as if the user had typed them.
 *
 * That is not hypothetical. Claude Code polls DECXCPR (`ESC [ ? 6 n`) every
 * 200ms to detect an externally-cleared screen; an answer of row=1 makes it
 * conclude the screen was wiped and submit `/clear`, which starts a new session.
 * With tens of thousands of unanswered `?6n` accumulated in the buffer, a single
 * replay (lid-wake remount, task reactivation) produces a flood of row=1 answers
 * and wipes the conversation. Measured on live sessions: 24k–35k copies each,
 * ~25% of the buffer's byte cap, evicting real scrollback.
 *
 * SCOPE IS DELIBERATELY NARROW — cursor position and DSR status only.
 *
 * Other queries (DECRQM `ESC [ ? <n> $ p` for synchronized output, XTVERSION
 * `ESC [ > 0 q`) are NOT stripped and must not be: the server does not answer
 * those, so today they legitimately round-trip to the renderer, xterm.js answers
 * them, and programs use the reply for capability detection. On the local path
 * the buffered value is also the value streamed live to the renderer, so
 * stripping a query from the buffer removes it from the live stream too —
 * widening this set would silently drop working capability detection.
 *
 * Lives in `@slayzone/platform` rather than `@slayzone/terminal/shared` because
 * BOTH pty output paths need it and they cannot share a domain package: the
 * terminal domain's `pty-manager` (local spawns) and the runner's `handlers/pty`
 * (remote spawns, bundled standalone). A mirrored copy is exactly the drift that
 * let this bug exist on one path — one definition, two importers.
 */

/**
 * Cursor-position / status QUERIES (program → terminal). Never a response.
 *
 *  - `ESC [ ? <n...> n`  DEC private DSR, incl. DECXCPR `?6n` (cursor position)
 *  - `ESC [ <n...> n`    ANSI DSR, incl. CPR `6n` and status `5n`
 *
 * The `n` final byte is unambiguous: no cursor-movement, erase, SGR, or
 * private-mode-set sequence ends in `n`. Text containing a literal "n" is
 * unaffected — the pattern requires the `ESC [` introducer.
 */
const CURSOR_STATUS_QUERY = /\x1b\[\??[0-9;]*n/g

/**
 * Cursor-position / status RESPONSES (terminal → program).
 *
 *  - `ESC [ ? <r> ; <c> R`  DECXCPR response
 *  - `ESC [ <r> ; <c> R`    CPR response
 *  - `ESC [ <n> n`          DSR status response (e.g. `0n`)
 *
 * Used to drop answers a renderer-side emulator generated on its own: the server
 * is the sole authority for answering these, so a renderer-originated response is
 * stale by construction and must not reach the process's stdin.
 *
 * Excludes DECRPM (`$y`) and XTVERSION replies on purpose — those are the
 * renderer's job to answer, per the scope note above.
 */
const CURSOR_STATUS_RESPONSE = /\x1b\[(?:\?[0-9]+;[0-9]+R|[0-9]+;[0-9]+R|[0-9]+n)/g

/** Remove cursor-position/status queries from a chunk of PTY output. */
export function stripDeviceStatusQueries(data: string): string {
  return data.replace(CURSOR_STATUS_QUERY, '')
}

/** Remove cursor-position/status responses from renderer-originated input. */
export function stripDeviceStatusResponses(data: string): string {
  return data.replace(CURSOR_STATUS_RESPONSE, '')
}

/**
 * A trailing INCOMPLETE escape sequence that may be completed by the next chunk.
 * Deliberately broader than the query pattern: at the moment a chunk ends we
 * cannot know whether `ESC [ ? 6` will become `?6n` (a query, strip) or `?6h`
 * (a mode set, keep) — so we hold anything that could still become either and
 * decide once the final byte arrives.
 *
 * `?`, `<`, `>` are CSI private introducers; `0-9;:` are parameter bytes.
 */
const INCOMPLETE_CSI_TAIL = /\x1b(?:\[[?<>0-9;:]*)?$/

/**
 * Longest tail worth holding. A cursor-status query is <=12 bytes; anything
 * longer is a runaway/binary sequence, and holding it would stall the stream
 * (output stops appearing until some terminator eventually arrives). Past the
 * cap we release and accept that a query torn inside a 32-byte unterminated CSI
 * slips through — that combination does not occur in real terminal output.
 */
const MAX_HELD_TAIL = 32

/**
 * A stateful stripper plus a `flush()` to drain whatever tail it is still
 * holding. `flush` exists because the held tail is otherwise invisible: the
 * instance is a closure, so retiring it (disposing the pty listener that feeds
 * it) silently discards those bytes.
 */
export interface DeviceStatusQueryStripper {
  (data: string): string
  /**
   * Return and clear any incomplete trailing sequence still held back. Call this
   * when the stripper is retired and its output handed to another consumer —
   * without it the tail is dropped and its continuation reaches that consumer
   * orphaned, which is the corruption the split-safe logic exists to prevent.
   * Idempotent: a second call returns `''`.
   */
  flush(): string
}

/**
 * Split-safe stripper: same removal set as {@link stripDeviceStatusQueries}, but
 * stateful across chunks.
 *
 * A one-shot regex cannot see a query torn by a read-buffer boundary — node-pty
 * splits wherever the OS filled its buffer, so `ESC [ ? 6` and `n` routinely
 * arrive in different chunks. Neither half matches, both survive, and they
 * reassemble contiguously in whatever consumes the stream — which is exactly the
 * poison this module exists to remove.
 *
 * Contract: returns the strippable-complete prefix of `carry + data` and retains
 * any incomplete trailing sequence for the next call. NOTHING is ever lost — a
 * held tail is emitted verbatim as soon as it is resolved, the cap is hit, or
 * {@link DeviceStatusQueryStripper.flush} is called — so the concatenation of all
 * return values (plus a final `flush()`) is the input minus queries only.
 *
 * One stripper instance per pty session (it carries per-stream state).
 */
export function createDeviceStatusQueryStripper(): DeviceStatusQueryStripper {
  let carry = ''
  const strip = (data: string): string => {
    const input = carry + data
    carry = ''
    const tail = input.match(INCOMPLETE_CSI_TAIL)?.[0] ?? ''
    if (tail && tail.length <= MAX_HELD_TAIL) {
      carry = tail
      return stripDeviceStatusQueries(input.slice(0, input.length - tail.length))
    }
    return stripDeviceStatusQueries(input)
  }
  strip.flush = (): string => {
    const held = carry
    carry = ''
    return held
  }
  return strip
}
