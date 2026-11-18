/**
 * What the timeline keeps for its rows across the list's recycling (a virtualised list
 * unmounts a row scrolled out of view and mounts it again later): which cards the user
 * opened or closed (tool output, thinking, a sub-agent), by a stable id; and the message
 * actions a long press opens. Provided by `ChatTimeline`; a row outside one (a test, a
 * sub-agent's own rows before) keeps its open state for as long as it is mounted.
 */
import { createContext, useCallback, useContext, useState, useSyncExternalStore } from 'react'

/** Open / closed by id; only what the user changed is kept (else the row's default). */
export class ExpandedStore {
  private readonly open = new Map<string, boolean>()
  private readonly listeners = new Map<string, Set<() => void>>()

  get(id: string): boolean | undefined {
    return this.open.get(id)
  }

  set(id: string, value: boolean): void {
    if (this.open.get(id) === value) return
    this.open.set(id, value)
    for (const listener of [...(this.listeners.get(id) ?? [])]) listener()
  }

  subscribe(id: string, listener: () => void): () => void {
    const set = this.listeners.get(id) ?? new Set()
    this.listeners.set(id, set)
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(id)
    }
  }
}

export interface TimelineUi {
  expanded: ExpandedStore
  /** A long press on a message: its actions (copy, share). */
  showMessageActions: (text: string) => void
}

export const TimelineUiContext = createContext<TimelineUi | null>(null)

export function useTimelineUi(): TimelineUi | null {
  return useContext(TimelineUiContext)
}

const noop = (): void => undefined
const unsubscribeNoop = (): (() => void) => noop

/**
 * Whether the card `id` is open, kept by the timeline (`initial` until the user
 * toggles it); `id` undefined, or no timeline: kept by this row while it is mounted.
 */
export function useExpanded(id: string | undefined, initial: boolean): [boolean, () => void] {
  const store = useContext(TimelineUiContext)?.expanded ?? null
  const [local, setLocal] = useState(initial)
  const kept = store && id !== undefined ? store : null
  const subscribe = useCallback(
    (cb: () => void) => (kept && id !== undefined ? kept.subscribe(id, cb) : unsubscribeNoop()),
    [kept, id]
  )
  const read = useCallback(() => (kept && id !== undefined ? kept.get(id) : undefined), [kept, id])
  const stored = useSyncExternalStore(subscribe, read, read)
  const open = kept ? (stored ?? initial) : local
  const toggle = useCallback(() => {
    if (kept && id !== undefined) kept.set(id, !(kept.get(id) ?? initial))
    else setLocal((o) => !o)
  }, [kept, id, initial])
  return [open, toggle]
}
