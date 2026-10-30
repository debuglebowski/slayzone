import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react'

/**
 * "Show this tool card": a request to open a card (from the files-changed row),
 * kept until the card has seen it — the card may mount only after the timeline
 * scrolled it in. One store per chat panel; a card subscribes to its own id, so
 * a request re-renders that card only.
 */
export class ToolFocusStore {
  private pending = new Set<string>()
  private listeners = new Map<string, Set<() => void>>()

  /** Ask the card of `toolUseId` to open. */
  request(toolUseId: string): void {
    this.pending.add(toolUseId)
    this.notify(toolUseId)
  }

  isPending(toolUseId: string): boolean {
    return this.pending.has(toolUseId)
  }

  /** The card opened: the request is done. */
  ack(toolUseId: string): void {
    if (this.pending.delete(toolUseId)) this.notify(toolUseId)
  }

  subscribe(toolUseId: string, listener: () => void): () => void {
    let set = this.listeners.get(toolUseId)
    if (!set) {
      set = new Set()
      this.listeners.set(toolUseId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(toolUseId)
    }
  }

  private notify(toolUseId: string): void {
    for (const listener of this.listeners.get(toolUseId) ?? []) listener()
  }
}

export const ToolFocusContext = createContext<ToolFocusStore | null>(null)

/** Without a store there is nothing to unsubscribe from. */
const noUnsubscribe = (): void => undefined

/** True while the card of `toolUseId` is asked to open (the hook acks it once seen). */
export function useToolFocusRequest(toolUseId: string): boolean {
  const store = useContext(ToolFocusContext)
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(toolUseId, listener) ?? noUnsubscribe,
    [store, toolUseId]
  )
  const pending = useSyncExternalStore(subscribe, () => store?.isPending(toolUseId) ?? false)
  useEffect(() => {
    if (pending) store?.ack(toolUseId)
  }, [pending, store, toolUseId])
  return pending
}
