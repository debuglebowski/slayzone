import { createContext } from 'react'
import type { DragItem } from './layoutDnd'

/**
 * What the layout's groups, strips and slot dividers do, provided once by
 * TaskLayoutView so the column → group → tab tree needs no prop drilling.
 */
export interface LayoutActions {
  activateTab: (instanceId: string) => void
  /** Close a tab, asking first when its kind wants to (an agent whose session runs). */
  requestCloseTab: (instanceId: string) => void
  hideTab: (instanceId: string) => void
  renameTab: (instanceId: string, name: string) => void
  splitTab: (instanceId: string, zone: 'after' | 'right') => void
  /** Slot weights within a column: live while dragging a divider, persisted at its end. */
  resizeSlots: (columnId: string, weights: Record<string, number>, persist: boolean) => void
  /** A divider drag starts/ends (native views hide meanwhile; the end commits). */
  onResizeStart: () => void
  onResizeEnd: () => void
}

export const LayoutActionsContext = createContext<LayoutActions | null>(null)

/** The panel being dragged right now (its tab dims), or null. */
export const LayoutDragItemContext = createContext<DragItem | null>(null)
