/**
 * Provider-aware chat-mode catalog. `claude-chat` and `codex-chat` expose
 * different permission/runtime vocabularies — this keys the ordered mode
 * lists, defaults, and validity by terminal mode so the mode picker + the IPC
 * handlers resolve the right set per provider.
 *
 * Claude modes mirror `chat-mode.ts` (`claude --permission-mode`). Codex modes
 * map onto `codex app-server`'s approval-policy / sandbox vocabulary — see
 * `agents/codex/codex-chat-session.ts` `mapRuntimePolicy`.
 *
 * @module shared/chat-mode-catalog
 */

/** Claude permission modes, dropdown order. */
const CLAUDE_MODES: string[] = ['plan', 'auto-accept', 'auto', 'bypass']

/** Codex runtime modes, dropdown order (safest → most permissive). */
const CODEX_MODES: string[] = ['approval-required', 'auto-accept-edits', 'full-access']

/** Ordered mode ids offered for a terminal mode. */
export function chatModesForMode(mode: string): string[] {
  return mode === 'codex-chat' ? CODEX_MODES : CLAUDE_MODES
}

/** Default mode for a freshly created task in the given terminal mode. */
export function defaultChatModeForMode(mode: string): string {
  return mode === 'codex-chat' ? 'auto-accept-edits' : 'auto-accept'
}

/** True when `v` is a mode id valid for the given terminal mode. */
export function isValidChatModeForMode(mode: string, v: unknown): v is string {
  return typeof v === 'string' && chatModesForMode(mode).includes(v)
}
