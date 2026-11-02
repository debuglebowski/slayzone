import type {
  SessionInfo,
  TerminalState,
  ChatSessionStateEntry
} from '@slayzone/terminal-contracts'
import { listPtys, getState as getPtyState } from './pty-manager'
import { listChatSessions, getChatSessionState } from './chat-transport-manager'
import { mergeSessions } from '../session-merge'

let chatSource: {
  list(): ChatSessionStateEntry[]
  get(sessionId: string): TerminalState | 'not-spawned' | null
} | null = null
export function setChatSessionSource(source: typeof chatSource): void {
  chatSource = source
}
export const listChatSessionEntries = (): ChatSessionStateEntry[] =>
  chatSource ? chatSource.list() : listChatSessions()

/**
 * Aggregates terminal sessions across all transports (PTY + chat). The
 * `pty:state-change` IPC channel already serves both — this module promotes
 * that union to the API layer so the renderer can rehydrate tab state on
 * reload without knowing which transport backs each tab.
 *
 * Pure merge logic lives in `./session-merge` so tests don't need to load
 * the electron-bound pty-manager.
 */
export async function listSessions(): Promise<SessionInfo[]> {
  return mergeSessions({ ptys: await listPtys(), chats: listChatSessionEntries() })
}

export function getSessionState(sessionId: string): TerminalState | null {
  const ptyState = getPtyState(sessionId)
  if (ptyState !== null) return ptyState
  // getChatSessionState already filters `not-spawned` skeletons, so the
  // remaining variants are all valid TerminalState members.
  const chatState = chatSource ? chatSource.get(sessionId) : getChatSessionState(sessionId)
  if (chatState === 'not-spawned') return null
  return chatState
}
