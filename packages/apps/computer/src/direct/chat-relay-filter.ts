/**
 * Which tabs' FULL chat events this computer sends a hub (docs/direct-link.md): all,
 * until the hub configures it (`relay.watch`), then only the tabs a hub client
 * watches. Saved events are reported to the hub as an `event-signal` regardless.
 *
 * @module computer/direct/chat-relay-filter
 */
export interface ChatRelayFilter {
  configure(all: boolean, tabIds: readonly string[]): void
  wantsFull(tabId: string): boolean
}

export function createChatRelayFilter(): ChatRelayFilter {
  let all = true
  let tabs = new Set<string>()
  return {
    configure(nextAll, tabIds) {
      all = nextAll
      tabs = new Set(tabIds)
    },
    wantsFull: (tabId) => all || tabs.has(tabId)
  }
}
