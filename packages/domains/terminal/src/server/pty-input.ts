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
import { containsSubmitEnter } from '@slayzone/terminal-contracts'
import { appendInput, isInterruptKey } from './stdin-input'

export interface PtyInputFacts {
  /** The write is the user's Esc key (not a mouse report that contains ESC). */
  esc: boolean
  /**
   * On submit-Enter: everything typed since the last one, Enter bytes included
   * (terminal reports dropped). Null when this write submits nothing.
   */
  submitted: string | null
  /** The submitted line asks the agent for its conversation id (`/status`, …). */
  statusCommand: boolean
}

/** Default conversation-id command when the adapter names none. */
export const DEFAULT_SESSION_ID_COMMAND = '/status'

/**
 * Fold `data` into the session's accumulated `buffer`. Returns the next buffer
 * (reset on submit-Enter) and the facts of this write.
 */
export function analyzePtyInput(
  buffer: string,
  data: string,
  sessionIdCommand: string = DEFAULT_SESSION_ID_COMMAND
): { buffer: string; facts: PtyInputFacts } {
  const esc = isInterruptKey(data)
  const next = appendInput(buffer, data)
  // Submit-Enter includes the kitty CSI-u encoding: once claude-code enables the
  // kitty keyboard protocol, Enter arrives as `ESC [ 13 u` and no \r ever does.
  if (!containsSubmitEnter(data)) {
    return { buffer: next, facts: { esc, submitted: null, statusCommand: false } }
  }
  return {
    buffer: '',
    facts: { esc, submitted: next, statusCommand: next.includes(sessionIdCommand) }
  }
}
