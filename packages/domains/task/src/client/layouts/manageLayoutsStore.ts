/**
 * Which layout dialog is open, window-wide: Manage layouts, or the layout editor
 * on one definition (or a new one). Opened from a task's Layout menu, from
 * Settings → Panels (through `OPEN_MANAGE_LAYOUTS_EVENT`: settings does not import
 * task, and the app shell mounts the host on it) and from Manage layouts itself.
 * `ManageLayoutsHost` renders it.
 */
import { useSyncExternalStore } from 'react'
import { OPEN_MANAGE_LAYOUTS_EVENT, type LayoutTree } from '@slayzone/task-contracts'

export interface LayoutEditorTarget {
  /** The definition to edit; null = a new layout. */
  layoutId: string | null
  /** A new layout's starting tree and name (default: one agent panel, "New layout"). */
  seed?: { name: string; tree: LayoutTree }
}

interface State {
  manageOpen: boolean
  editor: LayoutEditorTarget | null
}

let state: State = { manageOpen: false, editor: null }
const listeners = new Set<() => void>()

function set(next: Partial<State>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

export const layoutDialogs = {
  /**
   * Open Manage layouts. Also signals the app shell, which mounts `ManageLayoutsHost`
   * on first use (it is lazy: nothing of it loads at boot).
   */
  openManage: (): void => {
    set({ manageOpen: true })
    window.dispatchEvent(new CustomEvent(OPEN_MANAGE_LAYOUTS_EVENT))
  },
  /** Open it without signalling (the host answering that signal). */
  showManage: (): void => set({ manageOpen: true }),
  closeManage: (): void => set({ manageOpen: false }),
  openEditor: (target: LayoutEditorTarget): void => set({ editor: target }),
  closeEditor: (): void => set({ editor: null })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLayoutDialogs(): State {
  return useSyncExternalStore(subscribe, () => state)
}
