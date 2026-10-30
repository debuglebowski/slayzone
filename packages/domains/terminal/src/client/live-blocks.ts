/**
 * What streams into each chat row (plan 3.2), outside React state: the panel
 * publishes the reducer's `state.live` once per render, and a row subscribes to
 * its own key only. A delta therefore re-renders the one row that streams — the
 * timeline, the context and every other row stay untouched.
 *
 * @module terminal/client/live-blocks
 */
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import { liveBlockOf, type LiveBlock, type LiveBlocks } from '../shared/chat-timeline'

const EMPTY: LiveBlocks = Object.freeze([])

export class LiveBlockStore {
  private current: LiveBlocks = EMPTY
  private readonly listeners = new Map<string, Set<() => void>>()

  /** Adopt the reducer's live blocks; notify each key whose block changed. */
  publish(next: LiveBlocks): void {
    if (next === this.current) return
    const prev = this.current
    this.current = next
    for (const [key, set] of this.listeners) {
      if (liveBlockOf(prev, key) === liveBlockOf(next, key)) continue
      for (const cb of [...set]) cb()
    }
  }

  get(key: string): LiveBlock | undefined {
    return liveBlockOf(this.current, key)
  }

  subscribe(key: string, cb: () => void): () => void {
    let set = this.listeners.get(key)
    if (!set) {
      set = new Set()
      this.listeners.set(key, set)
    }
    set.add(cb)
    return () => {
      const current = this.listeners.get(key)
      if (!current) return
      current.delete(cb)
      if (current.size === 0) this.listeners.delete(key)
    }
  }

  /** Keys with a subscriber (tests). */
  listenerCount(): number {
    return this.listeners.size
  }
}

/** The panel's store. Its value never changes, so providing it re-renders nothing. */
export const LiveBlockStoreContext = createContext<LiveBlockStore | null>(null)

const noop = (): void => undefined

/**
 * The live block streaming into the row keyed `key` (`streamKeyOf`), or
 * undefined. Pass undefined for a row that is not streaming: it subscribes to
 * nothing and never re-renders for a delta.
 */
export function useLiveBlock(key: string | undefined): LiveBlock | undefined {
  const store = useContext(LiveBlockStoreContext)
  const subscribe = useCallback(
    (cb: () => void) => (store && key ? store.subscribe(key, cb) : noop),
    [store, key]
  )
  const get = useCallback(() => (store && key ? store.get(key) : undefined), [store, key])
  return useSyncExternalStore(subscribe, get, get)
}
