import { useSyncExternalStore } from 'react'
import type { SidebarViewContext } from './types'

/**
 * The data the tree sidebar last rendered, for the lens settings page's "Real data"
 * preview — Settings has no task list of its own. Written by the live `TreeView`
 * after each render; null until the tree has rendered once.
 */
let snapshot: SidebarViewContext | null = null
const listeners = new Set<() => void>()

export function publishSidebarSnapshot(ctx: SidebarViewContext): void {
  if (snapshot === ctx) return
  snapshot = ctx
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSidebarSnapshot(): SidebarViewContext | null {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => null
  )
}
