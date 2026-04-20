/** Modes for which the chat transport is available. Keep in sync with main/agents/registry.ts */
export const CHAT_SUPPORTED_MODES: readonly string[] = ['claude-code']

export function isChatSupported(mode: string): boolean {
  return CHAT_SUPPORTED_MODES.includes(mode)
}
