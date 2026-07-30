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
 * point. DECRQM (`$p`) and XTVERSION (`>q`) are untouched — the renderer legitimately
 * answers those, and stripping them would break capability detection.
 *
 * @returns disposables for the registered handlers; dispose to restore xterm's
 * built-in behaviour.
 */
export function suppressDeviceStatusReplies(
  terminal: Pick<XTerm, 'parser'>
): IDisposable[] {
  const handled = (): boolean => true
  return [
    // ANSI DSR — includes CPR `ESC[6n` and status `ESC[5n`.
    terminal.parser.registerCsiHandler({ final: 'n' }, handled),
    // DEC private DSR — includes DECXCPR `ESC[?6n`.
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'n' }, handled)
  ]
}
