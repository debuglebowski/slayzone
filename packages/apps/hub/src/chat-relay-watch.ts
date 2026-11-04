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
 * @module hub/chat-relay-watch
 */

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
}): ChatRelayWatch {
  let allWatchers = 0
  const tabs = new Map<string, number>()
  let lastKey = ''
  let scheduled = false

  const config = (): ChatRelayConfig => ({
    all: allWatchers > 0,
    tabIds: [...tabs.keys()].sort()
  })

  function push(): void {
    scheduled = false
    const next = config()
    const key = JSON.stringify(next)
    if (key === lastKey) return
    lastKey = key
    for (const computerId of deps.computers()) {
      void deps.send(computerId, next).catch(() => undefined)
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
      await deps.send(computerId, config()).catch(() => undefined)
    }
  }
}
