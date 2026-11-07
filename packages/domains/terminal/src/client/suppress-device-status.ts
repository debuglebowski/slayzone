import type { Terminal as XTerm, IDisposable } from '@xterm/xterm'

/**
 * Stop xterm.js from ANSWERING cursor-position / device-status queries.
 *
 * The server is the sole authority for answering these — synchronously, in the pty
 * `onData` path (`computeSyncQueryResponse`), because an async renderer round-trip
 * arrives too late and lands as garbage bytes in the program's stdin. So a
 * renderer-generated answer is always wrong, and it used to be removed after the
 * fact by filtering `onData` with `stripDeviceStatusResponses`.
 *
 * That filter cannot work, because a CPR reply is not distinguishable from a real
 * keystroke: xterm encodes modified F3 as `ESC [ 1 ; <mod> R` (`Keyboard.ts`),
 * which is byte-identical to a cursor-position report for row 1. Shift+F3,
 * Ctrl+F3 and Alt+F3 were therefore swallowed and never reached the process.
 * Plain F3 (`ESC O R`) and F1/F2/F4 were unaffected, which is what made it look
 * arbitrary.
 *
 * No pattern can separate the two — the bytes are the same. The fix is to stop the
 * reply being GENERATED: register CSI handlers for the `n` final byte and return
 * `true`, which xterm treats as "handled, stop dispatching" and so its own
 * `deviceStatus` / `deviceStatusPrivate` never run. Those two are the only
 * producers of these byte sequences on the input path, so nothing else has to be
 * filtered afterwards.
 *
 * Registration order matters and works in our favour: xterm dispatches CSI
 * handlers last-registered-first and stops on the first `true`
 * (`EscapeSequenceParser` CSI_DISPATCH), so a handler added after `open()`
 * pre-empts the built-in.
 *
 * Note this suppresses the *answer*, not the query: a program's `ESC[6n` still
 * reaches the terminal and is still answered by the server, which is the whole
 * point. DECRQM/DECRQSS have their own suppressor,
 * {@link suppressStateReportReplies}; XTVERSION has {@link suppressXtVersionReply}.
 *
 * @returns disposables for the registered handlers; dispose to restore xterm's
 * built-in behaviour.
 */
export function suppressDeviceStatusReplies(terminal: Pick<XTerm, 'parser'>): IDisposable[] {
  const handled = (): boolean => true
  return [
    // ANSI DSR — includes CPR `ESC[6n` and status `ESC[5n`.
    terminal.parser.registerCsiHandler({ final: 'n' }, handled),
    // DEC private DSR — includes DECXCPR `ESC[?6n`.
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'n' }, handled)
  ]
}

/**
 * Stop xterm.js from ANSWERING XTVERSION (`CSI > Ps q`).
 *
 * The server answers and strips this query now (`computeSyncQueryResponse`), so
 * a live one no longer reaches xterm at all. This exists for the *replay* path:
 * every session created before that change still carries an unanswered `ESC[>0q`
 * in its ring buffer, and the buffer is replayed into a fresh xterm on every
 * mount, reattach and renderer reload. xterm dutifully answers each replayed
 * copy with a DCS (`ESC P >|xterm.js(...) ESC \`), which `onData` then writes
 * into the LIVE program's stdin as though the user had typed it.
 *
 * Claude Code wedges on that unsolicited DCS: keystrokes keep arriving and drive
 * nothing, while output still renders (a SIGWINCH repaint paints a full frame),
 * so the session looks alive but ignores the keyboard until it is restarted.
 *
 * Same mechanism as the device-status suppression above — kill the reply at the
 * source rather than filter it afterwards. Kept separate because the two answer
 * to different owners: device-status is answered by the server for *timing*,
 * XTVERSION for *provenance* (a replayed query has no asker left to answer to).
 *
 * `CSI > Ps q` only; DECSCUSR (`CSI Ps SP q`) has no `>` prefix and is untouched.
 *
 * @returns disposables for the registered handler; dispose to restore xterm's
 * built-in behaviour.
 */
export function suppressXtVersionReply(terminal: Pick<XTerm, 'parser'>): IDisposable[] {
  return [terminal.parser.registerCsiHandler({ prefix: '>', final: 'q' }, () => true)]
}

/**
 * Stop xterm.js from ANSWERING state reports: DECRQM (`CSI [?] Ps $ p`) and
 * DECRQSS (`DCS $ q Pt ST`).
 *
 * The server answers these now, from its own headless copy of the screen
 * (`TerminalReplyMirror`), and strips them from the output — so a live one never
 * reaches xterm. A renderer answer was the late one: it rode the async round trip
 * and could land in the program's stdin after the program stopped waiting.
 * What xterm can still see is a REPLAYED query from a buffer recorded before
 * the server took over; answering that injects an unsolicited reply.
 *
 * Only the reports: setting modes (`CSI ? Ps h/l`) and SGR are other handlers
 * and keep working.
 *
 * @returns disposables for the registered handlers; dispose to restore xterm's
 * built-in behaviour.
 */
export function suppressStateReportReplies(terminal: Pick<XTerm, 'parser'>): IDisposable[] {
  const handled = (): boolean => true
  return [
    terminal.parser.registerCsiHandler({ intermediates: '$', final: 'p' }, handled),
    terminal.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, handled),
    terminal.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, handled)
  ]
}
