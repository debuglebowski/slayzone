/**
 * Which chat tabs the hub needs FULL events for: those a hub client watches
 * (`chat.onEvent`) — docs/direct-link.md. Computers send every saved event's summary
 * (`event-signal`) regardless, so hub-side records never depend on this; a client on
 * the direct link watches its computer instead, and the hub carries none of it.
 *
 * An unfiltered `chat.onEvent` (an older client) means "all". The config is pushed to
 * every connected computer when it changes (once per tick) and to a computer when it
 * (re)connects. A computer the hub never configured relays everything.
 *
 * Pushes are the hub's own act, sent as the hub (G2: a watch registered inside a
 * user's request must still reach computers that user does not own). A push that
 * fails is not counted as delivered and is retried.
 *
 * @module hub/chat-relay-watch
 */
import { runAsSecurityActor } from '@slayzone/platform/security-log'

export interface ChatRelayConfig {
  all: boolean
  tabIds: string[]
}

export interface ChatRelayWatch {
  /** A hub client watches these tabs (or all); returns unwatch. */
  watch(tabIds: readonly string[] | 'all'): () => void
  computerConnected(computerId: string): Promise<void>
}

export function createChatRelayWatch(deps: {
  computers(): readonly string[]
  send(computerId: string, config: ChatRelayConfig): Promise<unknown>
  /** After a failed push. Default 2 s. */
  retryMs?: number
  log?: (message: string, detail: Record<string, unknown>) => void
}): ChatRelayWatch {
  const retryMs = deps.retryMs ?? 2_000
  let allWatchers = 0
  const tabs = new Map<string, number>()
  /** The config each computer last acknowledged. */
  const delivered = new Map<string, string>()
  let scheduled = false
  let retry: ReturnType<typeof setTimeout> | null = null

  const config = (): ChatRelayConfig => ({
    all: allWatchers > 0,
    tabIds: [...tabs.keys()].sort()
  })

  function send(computerId: string, next: ChatRelayConfig, key: string): Promise<void> {
    return runAsSecurityActor(null, () => deps.send(computerId, next)).then(
      () => {
        delivered.set(computerId, key)
      },
      (err: unknown) => {
        delivered.delete(computerId)
        deps.log?.('chat relay watch push failed; retrying', { computerId, error: String(err) })
        if (!retry) {
          retry = setTimeout(() => {
            retry = null
            changed()
          }, retryMs)
          retry.unref?.()
        }
      }
    )
  }

  function push(): void {
    scheduled = false
    const next = config()
    const key = JSON.stringify(next)
    for (const computerId of deps.computers()) {
      if (delivered.get(computerId) === key) continue
      void send(computerId, next, key)
    }
  }

  function changed(): void {
    if (scheduled) return
    scheduled = true
    queueMicrotask(push)
  }

  return {
    watch(tabIds) {
      if (tabIds === 'all') {
        allWatchers++
        changed()
        let done = false
        return () => {
          if (done) return
          done = true
          allWatchers--
          changed()
        }
      }
      const ids = [...new Set(tabIds)]
      for (const id of ids) tabs.set(id, (tabs.get(id) ?? 0) + 1)
      changed()
      let done = false
      return () => {
        if (done) return
        done = true
        for (const id of ids) {
          const n = (tabs.get(id) ?? 1) - 1
          if (n <= 0) tabs.delete(id)
          else tabs.set(id, n)
        }
        changed()
      }
    },
    async computerConnected(computerId) {
      // A reconnected computer starts from nothing: whatever it acknowledged before
      // is gone with its old process or link.
      delivered.delete(computerId)
      const next = config()
      await send(computerId, next, JSON.stringify(next))
    }
  }
}
