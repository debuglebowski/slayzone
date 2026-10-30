import type { IpcMainLike } from '../pty-host'
import type { SlayzoneDb } from '@slayzone/platform'
import { TypedEmitter } from '@slayzone/platform/events'
import {
  dispatchUserMessage,
  ensureSpawned,
  getEventBufferSince,
  getSessionTerminalState,
  isReadyForQueuedMessage,
  registerChatQueueDrainer
} from './chat-transport-manager'
import { createDbChatQueueData, type ChatQueueData } from './chat-queue-data'
import { admitAttachments, type AttachmentLookup } from './chat-attachment-guard'
import { createDbAttachmentLookup } from './chat-data-ops'
import { getPtyHostBridge } from '../pty-host'
import type { QueuedChatMessage, UserContentBlock } from '@slayzone/terminal-contracts'

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

/** Tell every client a tab's queue changed (also after a server-side clear). */
export function notifyChatQueueChanged(tabId: string): void {
  broadcast('chat:queue-changed', tabId)
}

/** One drain at a time per tab: concurrent triggers queue up behind it. */
const draining = new Map<string, Promise<void>>()

/**
 * How long an edit holds a queued message. The editor renews it while open, so
 * an editor that went away (window closed, renderer reloaded) cannot block the
 * queue for longer than this.
 */
export const HOLD_MS = 30_000

/**
 * Queued messages being edited, per tab → their expiry timers. While its head
 * is held, a tab's queue does not drain (FIFO: nothing jumps ahead of it). In
 * memory: holds end with the hub process, like the editors that made them.
 */
const holds = new Map<string, Map<string, ReturnType<typeof setTimeout>>>()

function heldIds(tabId: string): string[] {
  return [...(holds.get(tabId)?.keys() ?? [])]
}

function dropHold(tabId: string, id: string): void {
  const tabHolds = holds.get(tabId)
  const timer = tabHolds?.get(id)
  if (timer) clearTimeout(timer)
  tabHolds?.delete(id)
  if (tabHolds?.size === 0) holds.delete(tabId)
}

function dropHolds(tabId: string): void {
  for (const id of heldIds(tabId)) dropHold(tabId, id)
}

/** Run `step` on the tab's drain chain (after any drain in progress). */
function onTabChain<T>(tabId: string, step: () => Promise<T>): Promise<T> {
  const previous = draining.get(tabId) ?? Promise.resolve()
  const run = previous.then(step)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  draining.set(tabId, settled)
  void settled.then(() => {
    if (draining.get(tabId) === settled) draining.delete(tabId)
  })
  return run
}

/**
 * Drain head of queue if the session is ready for it. Called by the transport
 * on state→idle transitions and on push (covers the "queue persisted across
 * restart, session boots into idle, no fresh transition fires" case).
 *
 * Ready = idle, not parked on a permission prompt (that idle flip is "waiting
 * on user", not "free to send next turn"; a user_message there would race the
 * SDK's pending tool_result), and no earlier message still on its way.
 *
 * ATOMIC: one drain per tab at a time, and the gate is checked again AFTER the
 * pop — the old drain checked "idle", awaited the pop, then sent, so two drains
 * could each pop a message and both go out at once. A pop that lost the race is
 * put back at the head.
 */
export function drainChatQueue(
  db: SlayzoneDb,
  tabId: string,
  data: ChatQueueData = createDbChatQueueData(db)
): Promise<void> {
  const previous = draining.get(tabId) ?? Promise.resolve()
  const run = previous
    .then(() => drainOnce(tabId, data))
    .catch((err) => {
      console.error('[chat-queue] drain failed:', err)
    })
  draining.set(tabId, run)
  void run.then(() => {
    if (draining.get(tabId) === run) draining.delete(tabId)
  })
  return run
}

async function drainOnce(tabId: string, data: ChatQueueData): Promise<void> {
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
  if (!isReadyForQueuedMessage(tabId)) return

  // A head being edited stays put (and everything behind it waits).
  const head = await data.pop(tabId, heldIds(tabId))
  if (!head) return
  // Re-check: a direct send (or a turn the agent started itself) may have
  // claimed the tab while the pop was in flight.
  if (!isReadyForQueuedMessage(tabId)) {
    try {
      await data.requeue(head)
    } catch (err) {
      console.error('[chat-queue] requeue failed:', err)
    }
    return
  }
  const content: UserContentBlock[] = head.content ?? [{ type: 'text', text: head.send }]
  try {
    // The row id becomes the message id: the outbox tracks it from here on.
    dispatchUserMessage(tabId, { id: head.id, content })
  } catch (err) {
    // The tab went away between check and dispatch: put it back for the next run.
    console.error('[chat-queue] dispatch failed, requeueing:', err)
    try {
      await data.requeue(head)
    } catch (err2) {
      console.error('[chat-queue] requeue failed:', err2)
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
export function createChatQueueOps(
  db: SlayzoneDb,
  data: ChatQueueData = createDbChatQueueData(db),
  lookup: AttachmentLookup = createDbAttachmentLookup(db)
) {
  // Wire drain into the transport so state transitions can pull from queue.
  // drainChatQueue is async; the drainer slot is fire-and-forget (invoked via
  // setImmediate in the transport), so float the promise explicitly.
  registerChatQueueDrainer((tabId) => {
    void drainChatQueue(db, tabId, data)
  })

  /** Files in a queued message pass the same gate as a direct send (checked + sealed). */
  const admit = (
    tabId: string,
    content: UserContentBlock[],
    exceptQueuedId?: string
  ): Promise<UserContentBlock[]> =>
    admitAttachments({
      tabId,
      content,
      lookup,
      events: getEventBufferSince(tabId, -1).map((e) => e.event),
      ...(exceptQueuedId ? { exceptQueuedId } : {})
    })

  return {
    list: (tabId: string): Promise<QueuedChatMessage[]> => data.list(tabId),

    push: async (
      tabId: string,
      send: string,
      original: string,
      opts?: { id?: string; content?: UserContentBlock[] }
    ): Promise<QueuedChatMessage> => {
      const content = opts?.content ? await admit(tabId, opts.content) : undefined
      const msg = await data.push(tabId, send, original, {
        ...(opts?.id ? { id: opts.id } : {}),
        ...(content ? { content } : {})
      })
      broadcast('chat:queue-changed', tabId)
      // Belt-and-suspenders drain: if the session is already idle when push
      // lands (renderer's inFlight mirror lags the transport), no fresh
      // state transition is coming — kick the drainer so the queue doesn't
      // sit. drainChatQueue itself gates on idle so this is safe.
      await drainChatQueue(db, tabId, data)
      return msg
    },

    /**
     * Rewrite a queued message (an edit). False when it was already sent or
     * removed — the editor then keeps the text for the composer.
     */
    update: async (
      id: string,
      next: { send: string; original: string; content: UserContentBlock[] }
    ): Promise<boolean> => {
      const tabId = await data.getTabIdForItem(id)
      if (tabId === null) return false
      const content = await admit(tabId, next.content, id)
      const updated = await data.update(id, { ...next, content })
      if (updated) broadcast('chat:queue-changed', tabId)
      return updated
    },

    /** Move a queued message to `toIndex` in its tab's order. */
    move: async (id: string, toIndex: number): Promise<boolean> => {
      const tabId = await data.getTabIdForItem(id)
      if (tabId === null) return false
      const moved = await data.move(id, toIndex)
      if (moved) {
        broadcast('chat:queue-changed', tabId)
        await drainChatQueue(db, tabId, data)
      }
      return moved
    },

    /**
     * Hold a queued message while it is edited (or renew the hold): the drain
     * won't send it, nor anything behind it. Runs on the tab's drain chain, so
     * a hold never races a pop. False when it was already sent or removed.
     */
    hold: async (id: string): Promise<boolean> => {
      const tabId = await data.getTabIdForItem(id)
      if (tabId === null) return false
      return onTabChain(tabId, async () => {
        if ((await data.getTabIdForItem(id)) === null) return false
        const tabHolds = holds.get(tabId) ?? new Map<string, ReturnType<typeof setTimeout>>()
        holds.set(tabId, tabHolds)
        const previous = tabHolds.get(id)
        if (previous) clearTimeout(previous)
        const timer = setTimeout(() => {
          // Lapsed (the editor went away): the queue moves on.
          dropHold(tabId, id)
          void drainChatQueue(db, tabId, data)
        }, HOLD_MS)
        timer.unref?.()
        tabHolds.set(id, timer)
        return true
      })
    },

    /** End an edit's hold; the queue drains if the agent is free. */
    release: async (id: string): Promise<void> => {
      for (const [tabId, tabHolds] of holds) {
        if (!tabHolds.has(id)) continue
        dropHold(tabId, id)
        await drainChatQueue(db, tabId, data)
        return
      }
    },

    remove: async (id: string): Promise<boolean> => {
      const tabId = await data.getTabIdForItem(id)
      const removed = await data.remove(id)
      if (tabId !== null) dropHold(tabId, id)
      // Gate on row existence (null check), not string truthiness — exact
      // parity with the pre-seam `removed && row` condition.
      if (removed && tabId !== null) broadcast('chat:queue-changed', tabId)
      return removed
    },

    clear: async (tabId: string): Promise<number> => {
      dropHolds(tabId)
      const cleared = await data.clear(tabId)
      if (cleared > 0) broadcast('chat:queue-changed', tabId)
      return cleared
    }
  }
}

export type ChatQueueOps = ReturnType<typeof createChatQueueOps>

/** Wire the IPC handlers to a shared `ChatQueueOps`. Logic-free delegation. */
export function registerChatQueueHandlers(ipcMain: IpcMainLike, queueOps: ChatQueueOps): void {
  ipcMain.handle(
    'chat:queue:list',
    (_, tabId: string): Promise<QueuedChatMessage[]> => queueOps.list(tabId)
  )
  ipcMain.handle(
    'chat:queue:push',
    (_, tabId: string, send: string, original: string): Promise<QueuedChatMessage> =>
      queueOps.push(tabId, send, original)
  )
  ipcMain.handle('chat:queue:remove', (_, id: string): Promise<boolean> => queueOps.remove(id))
  ipcMain.handle('chat:queue:clear', (_, tabId: string): Promise<number> => queueOps.clear(tabId))
}
