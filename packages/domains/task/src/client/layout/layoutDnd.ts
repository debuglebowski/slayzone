/**
 * Panel drag and drop, the pure part (docs/plans/panel-model.md §2): where a drop
 * lands (zone math) and which layout op it makes. The DOM side (pointer tracking,
 * hit-testing, the drop overlay) is LayoutDnd.tsx.
 *
 * A drag carries a tab (one panel instance) or a whole group (its strip header).
 * It lands either on a tab strip, at an insertion index (merge as a tab there, or
 * reorder within the same strip), or on a group's body, where the pointer's place
 * picks the zone: the outer 20% left/right opens a new column, the outer 30%
 * top/bottom a new slot above/below, the middle merges as a tab.
 */
import type { SplitZone, TaskLayout } from '@slayzone/task-contracts'
import { findSlot, findTab, mergeInto, moveSlot, splitAt } from '@slayzone/task-contracts'

export type DragItem = { type: 'tab'; instanceId: string } | { type: 'group'; slotId: string }

export type DropZone = SplitZone | 'merge'

export type DropTarget =
  /** A group's body; the zone comes from the pointer's place in it. */
  | { type: 'zone'; slotId: string; zone: DropZone }
  /** A tab strip, before the tab at `index` (= tab count: after the last). */
  | { type: 'strip'; slotId: string; index: number }

/** Share of a group's width (each side) that opens a new column. */
export const EDGE_X = 0.2
/** Share of a group's height (top and bottom) that opens a new slot. */
export const EDGE_Y = 0.3

/** The zone at a point given as fractions (0–1) of the group's width and height. */
export function zoneOf(rx: number, ry: number): DropZone {
  if (rx < EDGE_X) return 'left'
  if (rx > 1 - EDGE_X) return 'right'
  if (ry < EDGE_Y) return 'before'
  if (ry > 1 - EDGE_Y) return 'after'
  return 'merge'
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** The zone at client point (x, y) inside `rect`. */
export function zoneAt(rect: Box, x: number, y: number): DropZone {
  const rx = rect.width > 0 ? (x - rect.left) / rect.width : 0.5
  const ry = rect.height > 0 ? (y - rect.top) / rect.height : 0.5
  return zoneOf(rx, ry)
}

/** Insertion index in a strip: before the first tab whose midpoint is right of `x`. */
export function stripIndexAt(x: number, tabs: readonly Pick<Box, 'left' | 'width'>[]): number {
  const i = tabs.findIndex((t) => x < t.left + t.width / 2)
  return i < 0 ? tabs.length : i
}

/** Identity of a target, to skip re-rendering while the pointer stays on it. */
export function targetKey(target: DropTarget | null): string {
  if (!target) return ''
  return target.type === 'strip'
    ? `strip|${target.slotId}|${target.index}`
    : `zone|${target.slotId}|${target.zone}`
}

/** The group a drag item comes from. */
export function sourceSlotId(layout: TaskLayout, item: DragItem): string | null {
  if (item.type === 'group') return findSlot(layout, item.slotId) ? item.slotId : null
  const loc = findTab(layout, item.instanceId)
  return loc ? layout.columns[loc.columnIndex].slots[loc.slotIndex].id : null
}

/**
 * The layout after dropping `item` on `target`, or null when the drop changes
 * nothing (onto its own place, a lone tab onto its own group's edge, a group
 * onto itself) — the drag then ends without a write.
 */
export function applyDrop(
  layout: TaskLayout,
  item: DragItem,
  target: DropTarget
): TaskLayout | null {
  const from = sourceSlotId(layout, item)
  const to = findSlot(layout, target.slotId)
  if (!from || !to) return null
  const ownGroup = from === target.slotId

  if (item.type === 'group') {
    if (ownGroup) return null
    if (target.type === 'strip')
      return moveSlot(layout, from, { type: 'merge', slotId: target.slotId, index: target.index })
    if (target.zone === 'merge')
      return moveSlot(layout, from, { type: 'merge', slotId: target.slotId })
    return moveSlot(layout, from, { type: 'split', slotId: target.slotId, zone: target.zone })
  }

  const id = item.instanceId
  if (target.type === 'strip') {
    if (ownGroup) {
      const at = findTab(layout, id)?.tabIndex ?? -1
      // Before itself or right after itself: it stays where it is.
      if (target.index === at || target.index === at + 1) return null
    }
    return mergeInto(layout, id, target.slotId, target.index)
  }
  if (target.zone === 'merge') return ownGroup ? null : mergeInto(layout, id, target.slotId)
  if (ownGroup) {
    const slot = layout.columns[to.columnIndex].slots[to.slotIndex]
    if (slot.tabs.length < 2) return null
  }
  return splitAt(layout, id, target.slotId, target.zone)
}

export type DropPreview =
  /** Outline the whole group body: "merge as tab". */
  | { type: 'merge'; slotId: string }
  /** Outline the half of the group the new column/slot will take. */
  | { type: 'split'; slotId: string; zone: SplitZone }
  /** An insertion marker in a strip before tab `index`. */
  | { type: 'mark'; slotId: string; index: number }

/** What to highlight for a pending drop; null when the drop would change nothing. */
export function dropPreview(
  layout: TaskLayout,
  item: DragItem,
  target: DropTarget | null
): DropPreview | null {
  if (!target || !applyDrop(layout, item, target)) return null
  if (target.type === 'strip') return { type: 'mark', slotId: target.slotId, index: target.index }
  if (target.zone === 'merge') return { type: 'merge', slotId: target.slotId }
  return { type: 'split', slotId: target.slotId, zone: target.zone }
}
