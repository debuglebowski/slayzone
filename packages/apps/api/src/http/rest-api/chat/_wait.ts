/**
 * Wait until a chat tab's turn settles — the chat twin of `/api/pty/:id/wait`.
 * Chat has no "awaiting prompt" state (a parked turn reads `idle`), so the
 * outcome is computed from the computer's turn status, the queue, and — for
 * `answered` — the sent message's delivery: its row in the saved history (read
 * once, in bounded pages), then the live summaries of every saved event.
 * Re-evaluated on every chat event, state change and queue change for the tab,
 * plus a slow safety poll; none of them reads the history again, except the poll,
 * rarely, while the delivery is still unknown.
 */
import type { ChatSavedSummary, ChatTurnStatus } from '@slayzone/terminal-contracts'
import { chatHistoryDelivery } from '@slayzone/terminal/chat-history'
import type { ChatAccess } from '../types'
import { turnStatus, withChatTabHistory, type ChatTarget } from './_chat'

export type ChatWaitUntil = 'idle' | 'prompt' | 'answered'
export type ChatWaitOutcome = 'idle' | 'prompt' | 'answered' | 'dead' | 'error' | 'timeout'

export interface ChatWaitResult {
  outcome: ChatWaitOutcome
  status: ChatTurnStatus | null
  queued: number
  /** Why `error`: the message's delivery error, or the failed turn. */
  error?: string
}

const SAFETY_POLL_MS = 5000
/** How often the safety poll may read the saved history again while the delivery is unknown. */
const SAVED_REREAD_MS = 30_000

type Delivery = { state: string; error?: string }

/** The delivery state the saved history records for `messageId` (its row; bounded reads). */
async function savedDelivery(
  chat: ChatAccess,
  target: ChatTarget,
  messageId: string
): Promise<Delivery | null> {
  return withChatTabHistory(chat, target, (history) =>
    chatHistoryDelivery(history, messageId)
  ).catch(() => null)
}

async function queuedCount(chat: ChatAccess, target: ChatTarget): Promise<number> {
  const items = await Promise.resolve(chat.deps().queueOps.list(target.tabId)).catch(() => [])
  return Array.isArray(items) ? items.length : 0
}

export function waitForChat(
  chat: ChatAccess,
  target: ChatTarget,
  opts: { until: ChatWaitUntil; messageId?: string; timeoutMs: number; signal: AbortSignal }
): Promise<ChatWaitResult> {
  return new Promise((resolve, reject) => {
    const deps = chat.deps()
    let settled = false
    let running = false
    let dirty = false
    // Delivery of the awaited message, from live events (saved history covers the past).
    let delivery: Delivery | null = null
    /** When the saved history was last read for it (null: not yet). */
    let savedReadAt: number | null = null

    const cleanups: Array<() => void> = []
    const finish = (result: ChatWaitResult | Error) => {
      if (settled) return
      settled = true
      for (const c of cleanups) c()
      if (result instanceof Error) reject(result)
      else resolve(result)
    }

    const evaluate = async (fromPoll: boolean): Promise<ChatWaitResult | null> => {
      const [status, queued] = await Promise.all([
        turnStatus(chat, target),
        queuedCount(chat, target)
      ])
      if (status?.state === 'dead') return { outcome: 'dead', status, queued }
      if (status && status.pendingRequestIds.length > 0)
        return { outcome: 'prompt', status, queued }
      if (opts.until === 'prompt') return null
      if (opts.until === 'answered' && opts.messageId) {
        // The saved history once; again only from the safety poll, rarely (a summary
        // lost to a reconnect) — never on each event or state change.
        if (
          !delivery &&
          (savedReadAt === null || (fromPoll && Date.now() - savedReadAt >= SAVED_REREAD_MS))
        ) {
          savedReadAt = Date.now()
          const saved = await savedDelivery(chat, target, opts.messageId)
          // A live summary that came in meanwhile is newer.
          delivery ??= saved
        }
        const d = delivery
        if (d?.state === 'answered') return { outcome: 'answered', status, queued }
        if (d?.state === 'failed' || d?.state === 'cancelled')
          return {
            outcome: 'error',
            status,
            queued,
            error: d.error ?? `message ${d.state}`
          }
        return null
      }
      const settledTurn = !status || (!status.turnOpen && status.state !== 'starting')
      if (!settledTurn || queued > 0) return null
      if (status?.state === 'error')
        return { outcome: 'error', status, queued, error: 'turn failed' }
      return { outcome: 'idle', status, queued }
    }

    const check = (fromPoll = false) => {
      if (settled) return
      if (running) {
        dirty = true
        return
      }
      running = true
      evaluate(fromPoll).then(
        (result) => {
          running = false
          if (result) finish(result)
          else if (dirty) {
            dirty = false
            check()
          }
        },
        (err) => {
          running = false
          finish(err instanceof Error ? err : new Error(String(err)))
        }
      )
    }

    // `saved` (not `event`): computers report every saved event to the hub, while the
    // full event reaches it only when a hub client watches the tab (docs/direct-link.md).
    const onEvent = (tabId: string, saved: ChatSavedSummary) => {
      if (tabId !== target.tabId) return
      if (opts.messageId && saved.kind === 'user-message-delivery' && saved.id === opts.messageId)
        delivery = {
          state: saved.state ?? 'unknown',
          ...(saved.error ? { error: saved.error } : {})
        }
      check()
    }
    const onExit = (tabId: string) => {
      if (tabId === target.tabId) check()
    }
    const onQueue = (tabId: string) => {
      if (tabId === target.tabId) check()
    }
    deps.events.on('saved', onEvent)
    deps.events.on('exit', onExit)
    deps.queueEvents.on('queue-changed', onQueue)
    cleanups.push(
      () => deps.events.off('saved', onEvent),
      () => deps.events.off('exit', onExit),
      () => deps.queueEvents.off('queue-changed', onQueue),
      chat.onStateChange((sessionId) => {
        if (sessionId === target.sessionId) check()
      })
    )
    const poll = setInterval(() => check(true), SAFETY_POLL_MS)
    const timer = setTimeout(() => {
      Promise.all([turnStatus(chat, target).catch(() => null), queuedCount(chat, target)]).then(
        ([status, queued]) => finish({ outcome: 'timeout', status, queued }),
        () => finish({ outcome: 'timeout', status: null, queued: 0 })
      )
    }, opts.timeoutMs)
    cleanups.push(
      () => clearInterval(poll),
      () => clearTimeout(timer)
    )
    const onAbort = () => finish({ outcome: 'timeout', status: null, queued: 0 })
    opts.signal.addEventListener('abort', onAbort)
    cleanups.push(() => opts.signal.removeEventListener('abort', onAbort))
    check()
  })
}
