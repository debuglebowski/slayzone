/**
 * The in-process chat runtime, as the pty side and the terminal lifecycle see it —
 * when this process runs one. `chat-transport-manager` registers its default
 * transport here when it loads (the computer, Electron, tests); the hub never
 * loads it (chat agents run on computers, lint:server-boundary), so every call
 * below is a no-op there. Kept apart so `pty-manager`, `session-registry`,
 * `shutdown` and `test-reset` reach the chat runtime without importing it.
 *
 * @module terminal/server/runtime/local-chat-runtime
 */
import type { ChatSessionStateEntry } from '@slayzone/terminal-contracts'

export type LocalChatState = 'not-spawned' | 'starting' | 'running' | 'idle' | 'error' | 'dead'

export interface LocalChatRuntime {
  killByTaskId(taskId: string): void
  setShuttingDown(v: boolean): void
  listChatSessions(): ChatSessionStateEntry[]
  getChatSessionState(sessionId: string): LocalChatState | null
  shutdownAll(options: { termGraceMs?: number; hardTimeoutMs?: number }): Promise<unknown>
  /** Clears ended sessions + in-flight spawns, re-opens the chat gate, drops a
   *  spec's shortened watchdog. */
  resetForTests(): void
}

let runtime: LocalChatRuntime | null = null

export function registerLocalChatRuntime(next: LocalChatRuntime | null): void {
  runtime = next
}

export function localChatRuntime(): LocalChatRuntime | null {
  return runtime
}
