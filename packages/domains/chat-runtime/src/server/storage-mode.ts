/** Storage identity survives changes to UI handoff capabilities. */
export function chatStorageMode(mode: string): string {
  return mode === 'claude-code' ? 'claude-chat' : mode === 'codex' ? 'codex-chat' : mode
}

export function terminalStorageMode(mode: string): string {
  return mode === 'claude-chat' ? 'claude-code' : mode === 'codex-chat' ? 'codex' : mode
}
