/**
 * Chat events to direct-link clients (docs/direct-link.md), per tab, pinned to the
 * ownership epoch the hub checked when it granted the stream. The computer keeps its
 * own copy of each conversation's epoch; once it differs from the grant's (the
 * conversation moved or was deleted), the stream ends — the client goes back to
 * the hub, which knows where the tab lives now.
 *
 * @module computer/direct/chat-fanout
 */

/** One event, in the hub's `chat.onEvent` shape. */
export interface DirectChatEvent {
  tabId: string
  event: unknown
  seq: number
  live?: number
  at?: number
}

interface Watcher {
  epoch: number
  onEvent(event: DirectChatEvent): void
  onEnd(reason: 'epoch' | 'deleted' | 'disposed'): void
}

export interface DirectChatFanout {
  watch(
    tabId: string,
    epoch: number,
    onEvent: Watcher['onEvent'],
    onEnd: Watcher['onEnd']
  ): () => void
  /** One event the runtime published, with its conversation's current owner. */
  publish(
    owner: { tabId: string; epoch: number },
    payload: { event: unknown; seq: number; live?: number; at?: number }
  ): void
  /** The tab's conversation is gone (deleted, moved away): end its streams. */
  end(tabId: string, reason: 'epoch' | 'deleted' | 'disposed'): void
  endAll(): void
}

export function createDirectChatFanout(): DirectChatFanout {
  const byTab = new Map<string, Set<Watcher>>()

  function end(tabId: string, reason: Parameters<Watcher['onEnd']>[0]): void {
    const set = byTab.get(tabId)
    if (!set) return
    byTab.delete(tabId)
    for (const w of set) w.onEnd(reason)
  }

  return {
    watch(tabId, epoch, onEvent, onEnd) {
      const w: Watcher = { epoch, onEvent, onEnd }
      let set = byTab.get(tabId)
      if (!set) {
        set = new Set()
        byTab.set(tabId, set)
      }
      set.add(w)
      return () => {
        set.delete(w)
        if (set.size === 0 && byTab.get(tabId) === set) byTab.delete(tabId)
      }
    },
    publish(owner, payload) {
      const set = byTab.get(owner.tabId)
      if (!set) return
      for (const w of [...set]) {
        if (w.epoch !== owner.epoch) {
          set.delete(w)
          w.onEnd('epoch')
          continue
        }
        w.onEvent(
          payload.live !== undefined
            ? { tabId: owner.tabId, event: payload.event, seq: payload.seq, live: payload.live }
            : payload.at !== undefined
              ? { tabId: owner.tabId, event: payload.event, seq: payload.seq, at: payload.at }
              : { tabId: owner.tabId, event: payload.event, seq: payload.seq }
        )
      }
      if (set.size === 0) byTab.delete(owner.tabId)
    },
    end,
    endAll() {
      for (const tabId of [...byTab.keys()]) end(tabId, 'disposed')
    }
  }
}
