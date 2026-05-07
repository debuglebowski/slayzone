import type { Database } from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import {
  sendUserMessage,
  getSessionInfo,
  getSessionTerminalState,
  registerChatQueueDrainer,
} from './chat-transport-manager'
import {
  listChatQueue,
  pushChatQueue,
  removeChatQueueItem,
  clearChatQueue,
  popChatQueueHead,
  requeueAtHead,
} from '../server/chat-queue-store'
import type { QueuedChatMessage } from '../shared/types'

/**
 * Lazy electron broadcast — same trick as chat-transport-manager so this file
 * stays importable from non-electron test contexts. In production wires
 * `chat:queue-changed` (refetch trigger) + `chat:queue-drained` (analytics).
 */
export const chatQueueEvents = new EventEmitter() as EventEmitter & {
  on(event: 'queue-changed', listener: (tabId: string) => void): EventEmitter
  on(event: 'queue-drained', listener: (tabId: string, original: string) => void): EventEmitter
  off(event: string, listener: (...args: unknown[]) => void): EventEmitter
}

function broadcast(channel: 'queue-changed' | 'queue-drained', ...args: unknown[]): void {
  chatQueueEvents.emit(channel, ...args)
}

/**
 * Drain head of queue if the session is currently idle. Called by the
 * transport on state→idle transitions and on push (covers the "queue
 * persisted across restart, session boots into idle, no fresh transition
 * fires" case). Gated on `terminalState === 'idle'` so drains during a
 * live turn don't interleave with the in-flight assistant response.
 *
 * Pop is atomic via a transaction; if `sendUserMessage` fails we
 * re-insert at head so the next drain retries.
 */
export function drainChatQueue(db: Database, tabId: string): void {
  if (getSessionTerminalState(tabId) !== 'idle') return
  const info = getSessionInfo(tabId)
  if (!info || info.ended) return

  const head = popChatQueueHead(db, tabId)
  if (!head) return

  const sent = sendUserMessage(tabId, head.send)
  if (!sent) {
    // Session died between gate-check and stdin write. Put it back so the
    // next idle transition (e.g. fresh respawn) can retry.
    try {
      requeueAtHead(db, head)
    } catch (err) {
      console.error('[chat-queue] requeue failed:', err)
    }
    return
  }
  broadcast('queue-changed', tabId)
  // `original` carries the raw `/cmd` token so the renderer's usage hook
  // bumps autocomplete tiebreak counts for the real input — not the
  // post-transform expansion.
  broadcast('queue-drained', tabId, head.original)
}

export function createChatQueueOps(db: Database) {
  // Wire drain into the transport so state transitions can pull from queue.
  registerChatQueueDrainer((tabId) => drainChatQueue(db, tabId))
  return {
    list: (tabId: string): QueuedChatMessage[] => listChatQueue(db, tabId),
    push: (tabId: string, send: string, original: string): QueuedChatMessage => {
      const msg = pushChatQueue(db, tabId, send, original)
      broadcast('queue-changed', tabId)
      drainChatQueue(db, tabId)
      return msg
    },
    remove: (id: string): boolean => {
      const row = db.prepare('SELECT tab_id FROM chat_queue WHERE id = ?').get(id) as
        | { tab_id: string }
        | undefined
      const removed = removeChatQueueItem(db, id)
      if (removed && row) broadcast('queue-changed', row.tab_id)
      return removed
    },
    clear: (tabId: string): number => {
      const cleared = clearChatQueue(db, tabId)
      if (cleared > 0) broadcast('queue-changed', tabId)
      return cleared
    },
  }
}
