import { useSyncExternalStore } from 'react'

export type LensEditorTab = 'structure' | 'show' | 'rows'

/**
 * Whether the "Edit lens" dialog is open, and on which tab. Module state so the lens
 * menu (and anything else) can open the one dialog the toolbar renders. The dialog
 * always edits the active lens: the menu applies a lens before opening it.
 */
let state: { open: boolean; tab: LensEditorTab } = { open: false, tab: 'structure' }
const listeners = new Set<() => void>()

function set(next: typeof state): void {
  state = next
  for (const l of listeners) l()
}

export function openLensEditor(tab: LensEditorTab = 'structure'): void {
  set({ open: true, tab })
}

export function closeLensEditor(): void {
  set({ ...state, open: false })
}

export function setLensEditorTab(tab: LensEditorTab): void {
  set({ ...state, tab })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLensEditor(): { open: boolean; tab: LensEditorTab } {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state
  )
}
