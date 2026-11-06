/**
 * What one stdin write means for its session — pure, so the hub (relayed writes)
 * and the computer (direct writes, docs/direct-link.md) compute it identically.
 *
 * The hub applies the facts (`applyPtyInputFacts` in runtime/pty-manager.ts): the
 * turn tracker's submitted prompt, the attention mark, a TUI's flip to running, the
 * conversation-id watch, and the Esc diagnostic. A direct write is analysed on the
 * computer and its facts reach the hub as a journaled `pty-input` event.
 *
 * Lean on purpose: reachable from `@slayzone/terminal/pty-detection`, which the
 * computer bundles.
 */
import { lastSubmitEnterEnd } from '@slayzone/terminal-contracts'
import { appendInput, isInterruptKey } from './stdin-input'

export interface PtyInputFacts {
  /** The write is the user's Esc key (not a mouse report that contains ESC). */
  esc: boolean
  /**
   * On submit-Enter: everything typed since the last one up to this write's last
   * Enter, Enter bytes included (terminal reports dropped); what the write carries
   * after that Enter starts the next line. Null when this write submits nothing.
   */
  submitted: string | null
  /** The submitted line asks the agent for its conversation id (`/status`, …). */
  statusCommand: boolean
}

/** Default conversation-id command when the adapter names none. */
export const DEFAULT_SESSION_ID_COMMAND = '/status'

/**
 * Fold `data` into the session's accumulated `buffer`. Returns the next buffer
 * (on submit-Enter: what followed the Enter) and the facts of this write.
 */
export function analyzePtyInput(
  buffer: string,
  data: string,
  sessionIdCommand: string = DEFAULT_SESSION_ID_COMMAND
): { buffer: string; facts: PtyInputFacts } {
  const esc = isInterruptKey(data)
  // Submit-Enter includes the kitty CSI-u encoding: once claude-code enables the
  // kitty keyboard protocol, Enter arrives as `ESC [ 13 u` and no \r ever does.
  const end = lastSubmitEnterEnd(data)
  if (end < 0) {
    return {
      buffer: appendInput(buffer, data),
      facts: { esc, submitted: null, statusCommand: false }
    }
  }
  // One write can carry keys typed after the Enter (sent together while an earlier
  // write was in flight): they start the next line, not this one.
  const submitted = appendInput(buffer, data.slice(0, end))
  return {
    buffer: appendInput('', data.slice(end)),
    facts: { esc, submitted, statusCommand: submitted.includes(sessionIdCommand) }
  }
}
