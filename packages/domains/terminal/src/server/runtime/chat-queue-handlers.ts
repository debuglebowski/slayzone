import type { IpcMainLike } from '../pty-host'
import type { SlayzoneDb } from '@slayzone/platform'
import { TypedEmitter } from '@slayzone/platform/events'
import {
  dispatchUserMessage,
  ensureSpawned,
  getEventBufferSince,
  getSessionTerminalState,
  getSessionInfo,
  isReadyForQueuedMessage,
  registerChatQueueDrainer,
  registerSteerListener,
  steerUserMessage,
  withdrawSteer
} from './chat-transport-manager'
import {
  createDbChatQueueData,
  type ChatQueueData,
  type ChatQueueAdmissions,
  type ChatQueuePushOptions,
  type QueueAdmission
} from './chat-queue-data'
import { randomUUID } from 'node:crypto'
import { admitAttachments, type AttachmentLookup } from './chat-attachment-guard'
import { createDbAttachmentLookup } from './chat-data-ops'
import { getPtyHostBridge } from '../pty-host'
import type { QueuedChatMessage, UserContentBlock } from '@slayzone/terminal-contracts'
import type { ChatTransport, SteerResult } from './chat-transport-manager'

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
type QueueTransport = Pick<
  ChatTransport,
  | 'dispatchUserMessage'
  | 'ensureSpawned'
  | 'getEventBufferSince'
  | 'getSessionTerminalState'
  | 'getSessionInfo'
  | 'isReadyForQueuedMessage'
  | 'registerChatQueueDrainer'
  | 'registerSteerListener'
  | 'steerUserMessage'
  | 'withdrawSteer'
>
const legacyQueueTransport: QueueTransport = {
  dispatchUserMessage,
  ensureSpawned,
  getEventBufferSince,
  getSessionTerminalState,
  getSessionInfo,
  isReadyForQueuedMessage,
  registerChatQueueDrainer,
  registerSteerListener,
  steerUserMessage,
  withdrawSteer
}
export function createChatQueueRuntime(transport: QueueTransport = legacyQueueTransport) {
  const {
    dispatchUserMessage,
    ensureSpawned,
    getEventBufferSince,
    getSessionTerminalState,
    getSessionInfo,
    isReadyForQueuedMessage,
    registerChatQueueDrainer,
    registerSteerListener,
    steerUserMessage,
    withdrawSteer
  } = transport

  const chatQueueEvents = new TypedEmitter<ChatQueueEventMap>()

  /**
   * Lazy electron broadcast — same trick as chat-transport-manager so this file
   * stays importable from non-electron test contexts. In production wires
   * `chat:queue-changed` (refetch trigger) + `chat:queue-drained` (analytics).
   * Dual-emits on `chatQueueEvents` first (tRPC subs, fires in every context incl.
   * tests), then the legacy `webContents.send` path.
   */
  function broadcast(
    channel: 'chat:queue-changed' | 'chat:queue-drained',
    ...args: unknown[]
  ): void {
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
  function notifyChatQueueChanged(tabId: string): void {
    broadcast('chat:queue-changed', tabId)
  }

  /** One drain at a time per tab: concurrent triggers queue up behind it. */
  const draining = new Map<string, Promise<void>>()
  const admissionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let closing = false

  /**
   * How long an edit holds a queued message. The editor renews it while open, so
   * an editor that went away (window closed, renderer reloaded) cannot block the
   * queue for longer than this.
   */
  const HOLD_MS = 30_000

  /**
   * Queued messages being edited, per tab → their expiry timers. While its head
   * is held, a tab's queue does not drain (FIFO: nothing jumps ahead of it). In
   * memory: holds end with the hub process, like the editors that made them.
   */
  const holds = new Map<string, Map<string, ReturnType<typeof setTimeout>>>()

  /**
   * Queued messages added to the running turn ("Send now") that the
   * agent has not picked up, per tab. Their rows stay in the queue — listed as
   * `steering`, not editable — until the transport reports the pickup (the row
   * leaves the queue) or gives them back (an ordinary queued row again). While
   * any waits, the tab's queue does not drain: the steered message goes first.
   * In memory: a hub restart ends the processes they were written to, so the
   * rows are ordinary queued messages again.
   */
  const steering = new Map<string, Set<string>>()

  function isSteering(tabId: string, id: string): boolean {
    return steering.get(tabId)?.has(id) ?? false
  }

  function markSteering(tabId: string, id: string): void {
    const ids = steering.get(tabId) ?? new Set<string>()
    steering.set(tabId, ids)
    ids.add(id)
  }

  /** True when it was marked. */
  function unmarkSteering(tabId: string, id: string): boolean {
    const ids = steering.get(tabId)
    if (!ids?.delete(id)) return false
    if (ids.size === 0) steering.delete(tabId)
    return true
  }

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
  function drainChatQueue(
    db: SlayzoneDb,
    tabId: string,
    data: ChatQueueData = createDbChatQueueData(db)
  ): Promise<void> {
    if (closing) return Promise.resolve()
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
    // A message added to the turn goes first: nothing is sent until the agent has it.
    if (steering.has(tabId)) return

    // A head being edited stays put (and everything behind it waits).
    const head = await data.pop(tabId, heldIds(tabId))
    if (!head) return
    // Re-check: a direct send (or a turn the agent started itself) may have
    // claimed the tab while the pop was in flight.
    if (
      !isReadyForQueuedMessage(tabId) ||
      (head.expectedConversationId !== undefined &&
        head.expectedConversationId !== getSessionInfo(tabId)?.sessionId)
    ) {
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
  function createChatQueueOps(
    db: SlayzoneDb,
    data: ChatQueueData & Partial<ChatQueueAdmissions> = createDbChatQueueData(db),
    lookup: AttachmentLookup = createDbAttachmentLookup(db)
  ) {
    const admissionKey = (tabId: string, key: string) => JSON.stringify([tabId, key])
    const clearAdmissionTimer = (tabId: string, key: string) => {
      const timerKey = admissionKey(tabId, key)
      const timer = admissionTimers.get(timerKey)
      if (timer) clearTimeout(timer)
      admissionTimers.delete(timerKey)
    }
    const watchAdmission = (tabId: string, admission: QueueAdmission): QueueAdmission => {
      if (closing) return admission
      clearAdmissionTimer(tabId, admission.key)
      const key = admissionKey(tabId, admission.key)
      const timer = setTimeout(
        () => {
          if (admissionTimers.get(key) !== timer) return
          admissionTimers.delete(key)
          if (closing) return
          if (Date.now() < admission.expiresAt) {
            watchAdmission(tabId, admission)
            return
          }
          void drainChatQueue(db, tabId, data)
        },
        Math.max(1, admission.expiresAt - Date.now() + 1)
      )
      timer.unref?.()
      admissionTimers.set(key, timer)
      return admission
    }
    // Wire drain into the transport so state transitions can pull from queue.
    // drainChatQueue is async; the drainer slot is fire-and-forget (invoked via
    // setImmediate in the transport), so float the promise explicitly.
    registerChatQueueDrainer((tabId) => {
      void drainChatQueue(db, tabId, data)
    })

    // What became of a steered message (on the tab's chain: never races a pop,
    // a hold, or a remove that withdraws it).
    registerSteerListener((tabId, id, outcome) => {
      void onTabChain(tabId, async () => {
        if (!unmarkSteering(tabId, id)) return
        if (outcome === 'picked-up') {
          // The agent has it (its row is in the timeline now): it leaves the queue.
          const row = (await data.list(tabId)).find((m) => m.id === id)
          await data.remove(id)
          broadcast('chat:queue-changed', tabId)
          if (row) broadcast('chat:queue-drained', tabId, row.original)
        } else {
          broadcast('chat:queue-changed', tabId)
        }
        // Not awaited: the drain runs on this chain, after this step.
        void drainChatQueue(db, tabId, data)
      }).catch((err) => {
        console.error('[chat-queue] steer outcome failed:', err)
      })
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

    /**
     * The tab holding a queued message, or null when it is gone — or held by another
     * tab than the one the caller named (robustness plan §9, v208: a queue item is
     * reached through its tab, so the caller's tab is what was authorized).
     */
    const itemTab = async (id: string, expectedTab?: string): Promise<string | null> => {
      const tabId = await data.getTabIdForItem(id)
      return tabId !== null && expectedTab !== undefined && tabId !== expectedTab ? null : tabId
    }

    return {
      list: async (tabId: string): Promise<QueuedChatMessage[]> => {
        const rows = await data.list(tabId)
        if (!steering.has(tabId)) return rows
        return rows.map((m) => (isSteering(tabId, m.id) ? { ...m, steering: true as const } : m))
      },

      /**
       * Add a queued message to the running turn ("Send now"): the
       * agent takes it after its current tool call. It stays listed (`steering`)
       * until picked up. Refused — the message stays queued as it was — when it
       * is being edited, already added, meant for another conversation, or the
       * agent can't take it (no turn running, a prompt waiting, Codex's turn
       * just ended).
       */
      steer: async (id: string, expectedTab?: string): Promise<SteerResult> => {
        const gone: SteerResult = { ok: false, reason: 'That message was already sent.' }
        const tabId = await itemTab(id, expectedTab)
        if (tabId === null) return gone
        const marked = await onTabChain(
          tabId,
          async (): Promise<
            { ok: true; row: QueuedChatMessage } | { ok: false; reason: string }
          > => {
            const row = (await data.list(tabId)).find((m) => m.id === id)
            if (!row) return gone
            if (isSteering(tabId, id)) return { ok: false, reason: 'It was already added.' }
            if (holds.get(tabId)?.has(id)) {
              return { ok: false, reason: 'That message is being edited.' }
            }
            if (
              row.expectedConversationId !== undefined &&
              row.expectedConversationId !== getSessionInfo(tabId)?.sessionId
            ) {
              return { ok: false, reason: 'That message is for another conversation.' }
            }
            markSteering(tabId, id)
            broadcast('chat:queue-changed', tabId)
            return { ok: true, row }
          }
        )
        if (!marked.ok) return marked
        const content: UserContentBlock[] = marked.row.content ?? [
          { type: 'text', text: marked.row.send }
        ]
        const result = await steerUserMessage(tabId, { id, content })
        if (!result.ok) {
          await onTabChain(tabId, async () => {
            if (unmarkSteering(tabId, id)) broadcast('chat:queue-changed', tabId)
          })
          void drainChatQueue(db, tabId, data)
        }
        return result
      },

      reserve: async (
        tabId: string,
        id: string,
        key: string,
        inputHash?: string
      ): Promise<QueueAdmission> => {
        if (!data.reserve) throw new Error('Queue admission unavailable')
        return watchAdmission(tabId, await data.reserve(tabId, id, key, inputHash))
      },
      renewReservation: async (
        tabId: string,
        admission: Pick<QueueAdmission, 'key' | 'token'>
      ): Promise<QueueAdmission> => {
        if (!data.renewReservation) throw new Error('Queue admission unavailable')
        return watchAdmission(tabId, await data.renewReservation(tabId, admission))
      },
      cancelReservation: async (
        tabId: string,
        admission: Pick<QueueAdmission, 'key' | 'token'>
      ): Promise<void> => {
        if (!data.cancelReservation) throw new Error('Queue admission unavailable')
        await data.cancelReservation(tabId, admission)
        clearAdmissionTimer(tabId, admission.key)
        await drainChatQueue(db, tabId, data)
      },

      push: async (
        tabId: string,
        send: string,
        original: string,
        opts?: ChatQueuePushOptions
      ): Promise<QueuedChatMessage> => {
        const id = opts?.id ?? randomUUID()
        const replay = await data.replay?.(tabId, send, original, { ...opts, id })
        if (replay) {
          broadcast('chat:queue-changed', tabId)
          await drainChatQueue(db, tabId, data)
          return replay
        }
        const admission =
          opts?.admission ??
          (data.reserve
            ? watchAdmission(tabId, await data.reserve(tabId, id, randomUUID()))
            : undefined)
        let settled = false
        let renewing = false
        const renewal =
          admission && !opts?.admission && data.renewReservation
            ? setInterval(() => {
                if (renewing || closing) return
                renewing = true
                void data.renewReservation!(tabId, admission)
                  .then((next) => {
                    watchAdmission(tabId, next)
                  })
                  .catch(() => {
                    /* Final push checks the durable lease. */
                  })
                  .finally(() => {
                    renewing = false
                  })
              }, 30_000)
            : undefined
        renewal?.unref?.()
        try {
          const content = opts?.content ? await admit(tabId, opts.content) : undefined
          const msg = await data.push(tabId, send, original, {
            id,
            ...(admission ? { admission } : {}),
            ...(opts?.expectedConversationId
              ? { expectedConversationId: opts.expectedConversationId }
              : {}),
            ...(content ? { content } : {}),
            ...(opts?.content ? { submittedContent: opts.content } : {})
          })
          settled = true
          broadcast('chat:queue-changed', tabId)
          // Belt-and-suspenders drain: if the session is already idle when push
          // lands (renderer's inFlight mirror lags the transport), no fresh
          // state transition is coming — kick the drainer so the queue doesn't
          // sit. drainChatQueue itself gates on idle so this is safe.
          await drainChatQueue(db, tabId, data)
          return msg
        } catch (error) {
          if (admission && data.cancelReservation) {
            try {
              await data.cancelReservation(tabId, admission)
              settled = true
              await drainChatQueue(db, tabId, data)
            } catch {
              /* The bounded lease retries cleanup after expiry. */
            }
          }
          throw error
        } finally {
          if (renewal) clearInterval(renewal)
          if (admission && settled) clearAdmissionTimer(tabId, admission.key)
        }
      },

      /**
       * Rewrite a queued message (an edit). False when it was already sent or
       * removed — the editor then keeps the text for the composer.
       */
      update: async (
        id: string,
        next: { send: string; original: string; content: UserContentBlock[] },
        expectedTab?: string
      ): Promise<boolean> => {
        const tabId = await itemTab(id, expectedTab)
        if (tabId === null || isSteering(tabId, id)) return false
        const content = await admit(tabId, next.content, id)
        const updated = await data.update(id, { ...next, content })
        if (updated) broadcast('chat:queue-changed', tabId)
        return updated
      },

      /** Move a queued message to `toIndex` in its tab's order. */
      move: async (id: string, toIndex: number, expectedTab?: string): Promise<boolean> => {
        const tabId = await itemTab(id, expectedTab)
        if (tabId === null || isSteering(tabId, id)) return false
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
      hold: async (id: string, expectedTab?: string): Promise<boolean> => {
        const tabId = await itemTab(id, expectedTab)
        if (tabId === null) return false
        return onTabChain(tabId, async () => {
          if ((await data.getTabIdForItem(id)) === null) return false
          // With the agent: no longer editable.
          if (isSteering(tabId, id)) return false
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
      release: async (id: string, expectedTab?: string): Promise<void> => {
        for (const [tabId, tabHolds] of holds) {
          if (!tabHolds.has(id) || (expectedTab !== undefined && tabId !== expectedTab)) continue
          dropHold(tabId, id)
          await drainChatQueue(db, tabId, data)
          return
        }
      },

      remove: async (id: string, expectedTab?: string): Promise<boolean> => {
        const tabId = await data.getTabIdForItem(id)
        if (tabId !== null && expectedTab !== undefined && tabId !== expectedTab) return false
        if (tabId !== null && isSteering(tabId, id)) {
          // Added to the turn: take it back from the agent first (on the chain,
          // so the queue cannot send it in between). One it kept stays listed.
          return onTabChain(tabId, async () => {
            if (isSteering(tabId, id)) {
              if (!(await withdrawSteer(tabId, id))) return false
              unmarkSteering(tabId, id)
            }
            const removed = await data.remove(id)
            if (removed) broadcast('chat:queue-changed', tabId)
            return removed
          })
        }
        const removed = await data.remove(id)
        if (tabId !== null) dropHold(tabId, id)
        // Gate on row existence (null check), not string truthiness — exact
        // parity with the pre-seam `removed && row` condition.
        if (removed && tabId !== null) broadcast('chat:queue-changed', tabId)
        return removed
      },

      clear: async (tabId: string): Promise<number> => {
        dropHolds(tabId)
        if (steering.has(tabId)) {
          // Steered messages are taken back first; one the agent kept stays listed.
          return onTabChain(tabId, async () => {
            const kept = new Set<string>()
            for (const id of [...(steering.get(tabId) ?? [])]) {
              if (await withdrawSteer(tabId, id)) unmarkSteering(tabId, id)
              else kept.add(id)
            }
            let cleared = 0
            for (const row of await data.list(tabId)) {
              if (!kept.has(row.id) && (await data.remove(row.id))) cleared++
            }
            if (cleared > 0) broadcast('chat:queue-changed', tabId)
            return cleared
          })
        }
        const cleared = await data.clear(tabId)
        if (cleared > 0) broadcast('chat:queue-changed', tabId)
        return cleared
      }
    }
  }
  async function close() {
    closing = true
    for (const timer of admissionTimers.values()) clearTimeout(timer)
    admissionTimers.clear()
    for (const tabId of holds.keys()) dropHolds(tabId)
    steering.clear()
    await Promise.allSettled(draining.values())
  }
  return {
    chatQueueEvents,
    notifyChatQueueChanged,
    HOLD_MS,
    drainChatQueue,
    createChatQueueOps,
    settleTab: (tabId: string) => draining.get(tabId) ?? Promise.resolve(),
    close
  }
}
export type ChatQueueRuntime = ReturnType<typeof createChatQueueRuntime>
const defaultQueueRuntime = createChatQueueRuntime()
export const {
  chatQueueEvents,
  notifyChatQueueChanged,
  HOLD_MS,
  drainChatQueue,
  createChatQueueOps
} = defaultQueueRuntime
