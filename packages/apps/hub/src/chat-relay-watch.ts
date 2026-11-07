/**
 * Which chat tabs the hub needs FULL events for: those a hub client watches
 * (`chat.onEvent`) — docs/direct-link.md. Computers send every saved event's summary
 * (`event-signal`) regardless, so hub-side records never depend on this; a client on
 * the direct link watches its computer instead, and the hub carries none of it.
 *
 * An unfiltered `chat.onEvent` (an older client) means "all". Each computer is told
 * only the watched tabs it holds (a tab whose computer is not known yet goes to
 * every computer), re-routed when a chat's ownership moves. The config is pushed to
 * a computer when its part changes (once per tick) and when it (re)connects. A
 * computer the hub never configured relays everything.
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
  /**
   * The computers holding a tab's conversation (a move: source and destination).
   * Empty: not known, so every computer is told. Absent: every computer, always.
   */
  computersOfTab?: (tabId: string) => Promise<readonly string[]>
  /** Tabs whose conversation changed owner: their computers are looked up again. */
  onOwnershipChange?: (listener: (tabIds: readonly string[]) => void) => () => void
  /** After a failed push. Default 2 s. */
  retryMs?: number
  log?: (message: string, detail: Record<string, unknown>) => void
}): ChatRelayWatch {
  const retryMs = deps.retryMs ?? 2_000
  let allWatchers = 0
  const tabs = new Map<string, number>()
  /** Where each watched tab lives, once looked up (absent: unknown, so everywhere). */
  const placement = new Map<string, readonly string[]>()
  /** Lookups per tab, so only the latest one's answer is kept. */
  const lookups = new Map<string, number>()
  /** The config each computer last acknowledged. */
  const delivered = new Map<string, string>()
  let scheduled = false
  let retry: ReturnType<typeof setTimeout> | null = null

  const config = (computerId: string): ChatRelayConfig => ({
    all: allWatchers > 0,
    tabIds: [...tabs.keys()]
      .filter((id) => {
        const at = placement.get(id)
        return !at || at.length === 0 || at.includes(computerId)
      })
      .sort()
  })

  function locate(tabId: string): void {
    const lookup = deps.computersOfTab
    if (!lookup) return
    const n = (lookups.get(tabId) ?? 0) + 1
    lookups.set(tabId, n)
    lookup(tabId).then(
      (at) => {
        if (lookups.get(tabId) !== n || !tabs.has(tabId)) return
        placement.set(tabId, [...at])
        changed()
      },
      () => {
        // Unknown: it stays with every computer.
      }
    )
  }

  deps.onOwnershipChange?.((tabIds) => {
    for (const id of tabIds) if (tabs.has(id)) locate(id)
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
    for (const computerId of deps.computers()) {
      const next = config(computerId)
      const key = JSON.stringify(next)
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
      for (const id of ids) {
        const n = tabs.get(id) ?? 0
        tabs.set(id, n + 1)
        if (n === 0) locate(id)
      }
      changed()
      let done = false
      return () => {
        if (done) return
        done = true
        for (const id of ids) {
          const n = (tabs.get(id) ?? 1) - 1
          if (n <= 0) {
            tabs.delete(id)
            placement.delete(id)
            lookups.delete(id)
          } else tabs.set(id, n)
        }
        changed()
      }
    },
    async computerConnected(computerId) {
      // A reconnected computer starts from nothing: whatever it acknowledged before
      // is gone with its old process or link.
      delivered.delete(computerId)
      const next = config(computerId)
      await send(computerId, next, JSON.stringify(next))
    }
  }
}
