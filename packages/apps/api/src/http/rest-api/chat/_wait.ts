/**
 * Wait until a chat tab's turn settles — the chat twin of `/api/pty/:id/wait`.
 * Chat has no "awaiting prompt" state (a parked turn reads `idle`), so the
 * outcome is computed from the computer's turn status, the queue, and — for
 * `answered` — the sent message's delivery events. Re-evaluated on every chat
 * event, state change and queue change for the tab, plus a slow safety poll.
 */
import type { AgentEvent, ChatSavedSummary, ChatTurnStatus } from '@slayzone/terminal-contracts'
import type { ChatAccess } from '../types'
import { turnStatus, type ChatTarget } from './_chat'

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

type Delivery = { state: string; error?: string }

/** The latest delivery state the saved history records for `messageId`. */
async function savedDelivery(
  chat: ChatAccess,
  target: ChatTarget,
  messageId: string
): Promise<Delivery | null> {
  const events = (await Promise.resolve(chat.deps().ops.getBufferSince(target.tabId, -1)).catch(
    () => []
  )) as Array<{ event: AgentEvent }>
  let last: Delivery | null = null
  for (const { event } of events) {
    if (event.kind === 'user-message-delivery' && event.id === messageId)
      last = { state: event.state, ...(event.error ? { error: event.error } : {}) }
  }
  return last
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

    const cleanups: Array<() => void> = []
    const finish = (result: ChatWaitResult | Error) => {
      if (settled) return
      settled = true
      for (const c of cleanups) c()
      if (result instanceof Error) reject(result)
      else resolve(result)
    }

    const evaluate = async (): Promise<ChatWaitResult | null> => {
      const [status, queued] = await Promise.all([
        turnStatus(chat, target),
        queuedCount(chat, target)
      ])
      if (status?.state === 'dead') return { outcome: 'dead', status, queued }
      if (status && status.pendingRequestIds.length > 0)
        return { outcome: 'prompt', status, queued }
      if (opts.until === 'prompt') return null
      if (opts.until === 'answered' && opts.messageId) {
        const d = delivery ?? (await savedDelivery(chat, target, opts.messageId))
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

    const check = () => {
      if (settled) return
      if (running) {
        dirty = true
        return
      }
      running = true
      evaluate().then(
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
    const poll = setInterval(check, SAFETY_POLL_MS)
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
