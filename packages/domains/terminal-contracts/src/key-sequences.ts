/**
 * Wire bytes for terminal key events. Shared between renderer (xterm key
 * handlers) and main (adapter encodeSubmit). One source so the same constant
 * never drifts between caller-side replicas.
 */

/** Carriage return — fires Enter on raw-mode TUIs (Ink, Bubble Tea, etc).
 *  LF (`\n`, 0x0A) is Ctrl+J on raw stdin and is treated as newline-in-input
 *  by most readline-style libraries — do NOT use for submit. */
export const ENTER = '\r'

/** Kitty keyboard protocol CSI u: keycode 13 (Enter), modifier 2 (Shift).
 *  Apps that opt in via `CSI > 1 u` recognize this as Shift+Enter, used to
 *  insert a newline within a multi-line input (instead of submitting). */
export const KITTY_SHIFT_ENTER = '\x1b[13;2u'

/** Kitty CSI-u encodings of a PLAIN Enter press: `ESC [ 13 u` or
 *  `ESC [ 13 ; 1 u` (modifier 1 = none), with an optional `:eventType`
 *  subparam when event-type reporting is on. Modified Enter (Shift = `;2`,
 *  etc.) deliberately does NOT match — Shift+Enter is newline-in-input, not
 *  a submit. */
const KITTY_PLAIN_ENTER_RE = /\x1b\[13(?:;1(?::\d+)?)?u/

/**
 * True when written stdin bytes contain a submit-Enter: a literal CR/LF, or
 * the kitty CSI-u plain-Enter encoding. When a TUI (Claude Code) enables the
 * kitty keyboard protocol, xterm encodes the Enter KEY as `ESC [ 13 u` — no
 * `\r` ever reaches the PTY, so a bare CR/LF check misses every typed submit
 * (was: `needs_attention` never fired for human-typed prompts because the
 * user-input mark keyed off CR/LF only).
 */
export function containsSubmitEnter(data: string): boolean {
  return data.includes('\r') || data.includes('\n') || KITTY_PLAIN_ENTER_RE.test(data)
}
