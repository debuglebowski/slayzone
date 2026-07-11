import type { IpcMainLike } from '../pty-host'
import type { SlayzoneDb } from '@slayzone/platform'
import { TypedEmitter } from '@slayzone/platform/events'
import {
  sendUserMessage,
  ensureSpawned,
  getSessionInfo,
  getSessionTerminalState,
  isSessionAwaitingUserInput,
  registerChatQueueDrainer
} from './chat-transport-manager'
import { createDbChatQueueData, type ChatQueueData } from './chat-queue-data'
import { getPtyHostBridge } from '../pty-host'
import type { QueuedChatMessage } from '../../shared/types'

/**
 * Chat-queue event emitter — the source for the tRPC `chat.onQueueChanged` /
 * `chat.onQueueDrained` subscriptions. Dual-emitted alongside the legacy
 * `webContents.send` broadcasts in `broadcast()` below; the IPC path stays
 * until the renderer drops `window.api` (slice 5).
 */
export type ChatQueueEventMap = {
  'queue-changed': [tabId: string]
  'queue-drained': [tabId: string, original: string]
}
export const chatQueueEvents = new TypedEmitter<ChatQueueEventMap>()

/**
 * Lazy electron broadcast — same trick as chat-transport-manager so this file
 * stays importable from non-electron test contexts. In production wires
 * `chat:queue-changed` (refetch trigger) + `chat:queue-drained` (analytics).
 * Dual-emits on `chatQueueEvents` first (tRPC subs, fires in every context incl.
 * tests), then the legacy `webContents.send` path.
 */
function broadcast(channel: 'chat:queue-changed' | 'chat:queue-drained', ...args: unknown[]): void {
  if (channel === 'chat:queue-changed') {
    chatQueueEvents.emit('queue-changed', args[0] as string)
  } else {
    chatQueueEvents.emit('queue-drained', args[0] as string, args[1] as string)
  }
  // Host bridge: real windows in Electron, inert in tests + standalone server.
  for (const w of getPtyHostBridge().getAllWindows()) {
    if (w.isDestroyed()) continue
    w.webContents.send(channel, ...args)
  }
}

/**
 * Drain head of queue if the session is currently idle. Called by the
 * transport on state→idle transitions and on push (covers the "queue
 * persisted across restart, session boots into idle, no fresh transition
 * fires" case). Gated on `terminalState === 'idle'` so drains during a
 * live turn don't interleave with the in-flight assistant response.
 *
 * Extra gate: `isSessionAwaitingUserInput` blocks drain during an inbound
 * permission-request (AskUserQuestion etc.) — that idle flip is "waiting on
 * user", not "free to send next turn"; a user_message here would race the
 * SDK's pending tool_result.
 *
 * Pop is atomic via a transaction; if `sendUserMessage` fails we
 * re-insert at head so the next drain retries.
 */
export async function drainChatQueue(
  db: SlayzoneDb,
  tabId: string,
  data: ChatQueueData = createDbChatQueueData(db)
): Promise<void> {
  const state = getSessionTerminalState(tabId)
  // Pre-spawn lazy trigger: a queued message arrived before the user ever
  // sent one (so the subprocess was never started). Fire ensureSpawned —
  // when it transitions through `starting → idle`, the transport's drainer
  // hook re-enters this function and the post-spawn branch below pops the
  // queue. Only trigger when there's actually something queued to avoid
  // spinning up a process for nothing.
  if (state === 'not-spawned') {
    if ((await data.list(tabId)).length === 0) return
    void ensureSpawned(tabId).catch((err) => {
      console.error('[chat-queue] ensureSpawned failed for pre-spawn drain:', err)
    })
    return
  }
  if (state !== 'idle') return
  if (isSessionAwaitingUserInput(tabId)) return
  const info = getSessionInfo(tabId)
  if (!info || info.ended) return

  const head = await data.pop(tabId)
  if (!head) return

  const sent = sendUserMessage(tabId, head.send)
  if (!sent) {
    // Session died between gate-check and stdin write. Put it back so the
    // next idle transition (e.g. fresh respawn) can retry.
    try {
      await data.requeue(head)
    } catch (err) {
      console.error('[chat-queue] requeue failed:', err)
    }
    return
  }
  broadcast('chat:queue-changed', tabId)
  // `original` carries the raw `/cmd` token so the renderer's usage hook
  // bumps autocomplete tiebreak counts for the real input — not the
  // post-transform expansion.
  broadcast('chat:queue-drained', tabId, head.original)
}

/**
 * Build the chat-queue ops object — the single implementation shared by the IPC
 * handlers (`registerChatQueueHandlers`) and the tRPC `chat.queue` router
 * (injected via `setChatDeps`). Wires the drainer side-effect once on creation.
 */
export function createChatQueueOps(db: SlayzoneDb, data: ChatQueueData = createDbChatQueueData(db)) {
  // Wire drain into the transport so state transitions can pull from queue.
  // drainChatQueue is async; the drainer slot is fire-and-forget (invoked via
  // setImmediate in the transport), so float the promise explicitly.
  registerChatQueueDrainer((tabId) => {
    void drainChatQueue(db, tabId, data)
  })

  return {
    list: (tabId: string): Promise<QueuedChatMessage[]> => data.list(tabId),

    push: async (tabId: string, send: string, original: string): Promise<QueuedChatMessage> => {
      const msg = await data.push(tabId, send, original)
      broadcast('chat:queue-changed', tabId)
      // Belt-and-suspenders drain: if the session is already idle when push
      // lands (renderer's inFlight mirror lags the transport), no fresh
      // state transition is coming — kick the drainer so the queue doesn't
      // sit. drainChatQueue itself gates on idle so this is safe.
      await drainChatQueue(db, tabId, data)
      return msg
    },

    remove: async (id: string): Promise<boolean> => {
      const tabId = await data.getTabIdForItem(id)
      const removed = await data.remove(id)
      // Gate on row existence (null check), not string truthiness — exact
      // parity with the pre-seam `removed && row` condition.
      if (removed && tabId !== null) broadcast('chat:queue-changed', tabId)
      return removed
    },

    clear: async (tabId: string): Promise<number> => {
      const cleared = await data.clear(tabId)
      if (cleared > 0) broadcast('chat:queue-changed', tabId)
      return cleared
    }
  }
}

export type ChatQueueOps = ReturnType<typeof createChatQueueOps>

/** Wire the IPC handlers to a shared `ChatQueueOps`. Logic-free delegation. */
export function registerChatQueueHandlers(ipcMain: IpcMainLike, queueOps: ChatQueueOps): void {
  ipcMain.handle('chat:queue:list', (_, tabId: string): Promise<QueuedChatMessage[]> =>
    queueOps.list(tabId)
  )
  ipcMain.handle(
    'chat:queue:push',
    (_, tabId: string, send: string, original: string): Promise<QueuedChatMessage> =>
      queueOps.push(tabId, send, original)
  )
  ipcMain.handle('chat:queue:remove', (_, id: string): Promise<boolean> => queueOps.remove(id))
  ipcMain.handle('chat:queue:clear', (_, tabId: string): Promise<number> => queueOps.clear(tabId))
}
