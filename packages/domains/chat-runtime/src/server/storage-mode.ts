/** Storage identity survives changes to UI handoff capabilities. */
export function chatStorageMode(mode: string): string {
  return mode === 'claude-code' ? 'claude-chat' : mode === 'codex' ? 'codex-chat' : mode
}

export function terminalStorageAgentId(mode: string): string {
  return mode === 'claude-chat' ? 'claude-code' : mode === 'codex-chat' ? 'codex' : mode
}

/** Storage-only owners (`artifact-store:`, `task-content:`) hold task-wide
 * storage — artifacts, legacy prompt history — never a provider session, and
 * have no terminal tab to reopen. */
export function isStorageOnlyChatOwner(owner: { taskId: string; tabId: string }): boolean {
  return owner.tabId.startsWith('artifact-store:') || owner.tabId === `task-content:${owner.taskId}`
}
