/**
 * Classifying what the renderer writes to a PTY's stdin.
 *
 * Stdin is not just typing. Every agent TUI (claude-code, codex, …) turns on
 * mouse tracking, after which xterm.js emits a report on each pointer move over
 * the pane and forwards it through the same `pty.write` path as a keystroke.
 * Measured on a live session: of 111,503 ESC-bearing writes, 94.3% were mouse
 * reports and 113 (0.1%) were the user's Esc key. Anything that reasons about
 * "did the user type something" therefore has to tell the two apart first.
 */

/**
 * True when this write is the user pressing Esc — the interrupt key for
 * claude-code and codex.
 *
 * Matches a bare ESC and the kitty CSI-u form (`CSI 27 [;mods[:event]] u`),
 * which is what actually arrives once claude-code enables the kitty keyboard
 * protocol. Anchored end-to-end: a write that merely *contains* an ESC byte is
 * usually a mouse report, which is exactly the confusion this replaces.
 */
export function isInterruptKey(data: string): boolean {
  if (data === '\x1b') return true
  return /^\x1b\[27(?::\d+)*(?:;\d+(?::\d+)*)*u$/.test(data)
}

// SGR (1006) and SGR-Pixels (1016): CSI < Cb ; Cx ; Cy M|m. The dominant
// encoding — 94.3% of observed ESC-bearing writes had exactly this shape.
const SGR_MOUSE = /\x1b\[<\d{1,5};\d{1,5};\d{1,5}[Mm]/g
// X10 / VT200 (1000, 1002, 1003): CSI M then exactly three payload bytes,
// which are raw values and may themselves look like anything.
const X10_MOUSE = /\x1b\[M[\s\S]{3}/g
// Focus tracking (1004): CSI I on focus in, CSI O on focus out. Note this is
// CSI O (`ESC [ O`), not SS3 (`ESC O`) which prefixes F1–F4.
const FOCUS_REPORT = /\x1b\[[IO]/g

/**
 * Drop the terminal's own reports, keeping everything the user actually typed.
 *
 * Deliberately narrow. A false strip silently eats a keystroke, which is far
 * worse than letting an unrecognised report through — so this covers only the
 * encodings confirmed in the wild, and `appendInput`'s cap is the backstop for
 * anything else. urxvt (1015) mouse reports are NOT stripped: their shape
 * (`CSI Cb ; Cx ; Cy M`) is ambiguous with ordinary CSI input.
 */
export function stripTerminalReports(data: string): string {
  return data.replace(SGR_MOUSE, '').replace(X10_MOUSE, '').replace(FOCUS_REPORT, '')
}

/**
 * Ceiling on the accumulated stdin buffer. Large enough to hold a genuine
 * multi-line paste (the biggest real one observed was ~28 KB), small enough
 * that a session can never pin meaningful memory on input alone.
 */
export const INPUT_BUFFER_MAX = 64_000

/**
 * Append a stdin write to a session's accumulated input, keeping only what the
 * user typed and bounding the result.
 *
 * The buffer is reset on submit-Enter, so a pane the user hovers over but never
 * submits in previously grew for the lifetime of the session.
 */
export function appendInput(buffer: string, data: string): string {
  const next = buffer + stripTerminalReports(data)
  return next.length <= INPUT_BUFFER_MAX ? next : next.slice(next.length - INPUT_BUFFER_MAX)
}
