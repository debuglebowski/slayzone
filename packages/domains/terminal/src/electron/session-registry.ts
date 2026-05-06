import type { SessionInfo, TerminalState } from '../shared/types'
import { listPtys, getState as getPtyState } from './pty-manager'
import { listChatSessions, getChatSessionState } from './chat-transport-manager'
import { mergeSessions } from '../server/session-merge'

/**
 * Aggregates terminal sessions across all transports (PTY + chat). The
 * `pty:state-change` IPC channel already serves both — this module promotes
 * that union to the API layer so the renderer can rehydrate tab state on
 * reload without knowing which transport backs each tab.
 *
 * Pure merge logic lives in `./session-merge` so tests don't need to load
 * the electron-bound pty-manager.
 */
export function listSessions(): SessionInfo[] {
  return mergeSessions({ ptys: listPtys(), chats: listChatSessions() })
}

export function getSessionState(sessionId: string): TerminalState | null {
  const ptyState = getPtyState(sessionId)
  if (ptyState !== null) return ptyState
  return getChatSessionState(sessionId)
}
