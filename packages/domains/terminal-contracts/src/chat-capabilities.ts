/**
 * What a chat provider can do, asked by the chat UI instead of checking
 * "is this Claude?". One entry per chat mode; a mode not listed gets nothing.
 * Codex keeps today's behavior until its own phase flips these on.
 *
 * Features gated on the data a provider reports (e.g. the context meter,
 * which only renders when results carry a context window) don't need an
 * entry here.
 *
 * @module shared/chat-capabilities
 */

export interface ChatCapabilities {
  /**
   * The provider runs its own slash commands from raw `/name args` user text
   * and advertises their names. The composer then passes unknown `/name` text
   * through on Enter, and Enter on an exactly typed command sends that text.
   */
  nativeSlashCommands: boolean
  /** The composer recalls the task's earlier prompts (↑/↓, Ctrl+R) and chat sends are recorded for it. */
  promptHistory: boolean
  /**
   * Every permission request, question and plan approval is answered from a
   * prompt card (the prompt dock), with the TUI's options and wording.
   */
  promptCards: boolean
}

const NONE: ChatCapabilities = {
  nativeSlashCommands: false,
  promptHistory: false,
  promptCards: false
}

const CAPABILITIES: Record<string, ChatCapabilities> = {
  'claude-chat': { nativeSlashCommands: true, promptHistory: true, promptCards: true },
  'codex-chat': NONE
}

export function chatCapabilitiesForMode(mode: string): ChatCapabilities {
  return CAPABILITIES[mode] ?? NONE
}
