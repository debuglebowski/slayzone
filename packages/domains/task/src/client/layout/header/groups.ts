/**
 * The title row's group toggles (docs/plans/panel-model.md step 9): one toggle per
 * tab group (layout slot), left to right then top to bottom. A hidden group keeps
 * its toggle in place, grayed out. A group's name is its own, else it is named from
 * its contents ("Agent", "Browser + Editor", "Terminal ×2").
 */
import type { LayoutSlot, PanelInstance, TaskLayout } from '@slayzone/task-contracts'
import { isSlotVisible } from '@slayzone/task-contracts'
import { panelTabMeta } from '../panelTabMeta'

export interface LayoutGroup {
  slotId: string
  columnId: string
  /** What the toggle is called: the group's own name, else `autoName`. */
  name: string
  /** The name its contents give it (the rename field's placeholder). */
  autoName: string
  /** The group's own name, if the user gave it one. */
  customName: string | null
  /** The instance whose icon the toggle shows: the shown tab, else the first one. */
  iconInstance: PanelInstance
  /** Every listed tab of the group, in tab order. */
  instanceIds: string[]
  /** The group takes room in the layout (not hidden, a tab shown). */
  active: boolean
}

export interface LayoutGroupsOptions {
  webPanels: readonly { id: string; name: string }[]
  /** A tab that gets no toggle (its kind is disabled, or this app can't render it). */
  isTabListed: (instance: PanelInstance) => boolean
  /**
   * A tab that keeps its whole group off the row: a secondary window never offers
   * the agent (PERMANENT, see TaskDetailPage).
   */
  excludesGroup?: (instance: PanelInstance) => boolean
}

/** A group's name from its tabs' labels, in tab order. */
export function groupNameOf(labels: readonly string[]): string {
  if (labels.length === 0) return ''
  const distinct = [...new Set(labels)]
  if (distinct.length === 1)
    return labels.length === 1 ? distinct[0] : `${distinct[0]} ×${labels.length}`
  if (distinct.length === 2) return `${distinct[0]} + ${distinct[1]}`
  return `${distinct[0]} + ${distinct.length - 1} more`
}

/** The group toggles of a layout, in column order then top to bottom. */
export function layoutGroups(layout: TaskLayout, opts: LayoutGroupsOptions): LayoutGroup[] {
  const out: LayoutGroup[] = []
  for (const column of layout.columns) {
    for (const slot of column.slots) {
      const group = groupOf(layout, column.id, slot, opts)
      if (group) out.push(group)
    }
  }
  return out
}

function groupOf(
  layout: TaskLayout,
  columnId: string,
  slot: LayoutSlot,
  opts: LayoutGroupsOptions
): LayoutGroup | null {
  const tabs = slot.tabs
    .map((tab) => ({ tab, instance: layout.instances[tab.instanceId] }))
    .filter((t): t is { tab: typeof t.tab; instance: PanelInstance } => !!t.instance)
  if (opts.excludesGroup && tabs.some((t) => opts.excludesGroup?.(t.instance))) return null
  const listed = tabs.filter((t) => opts.isTabListed(t.instance))
  if (listed.length === 0) return null
  const shown = listed.filter((t) => !t.tab.hidden)
  const named = shown.length > 0 ? shown : listed
  const icon = shown.find((t) => t.instance.id === slot.activeInstanceId) ?? shown[0] ?? listed[0]
  const autoName = groupNameOf(named.map((t) => panelTabMeta(t.instance, opts.webPanels).label))
  return {
    slotId: slot.id,
    columnId,
    name: slot.name ?? autoName,
    autoName,
    customName: slot.name ?? null,
    iconInstance: icon.instance,
    instanceIds: listed.map((t) => t.instance.id),
    active: isSlotVisible(slot)
  }
}

/**
 * A toggle dragged onto another: the column index its column moves to (null:
 * same column, nothing moves).
 */
export function columnMoveOf(
  layout: TaskLayout,
  groups: readonly LayoutGroup[],
  slotId: string,
  overSlotId: string
): { columnId: string; toIndex: number } | null {
  const from = groups.find((g) => g.slotId === slotId)
  const over = groups.find((g) => g.slotId === overSlotId)
  if (!from || !over || from.columnId === over.columnId) return null
  const toIndex = layout.columns.findIndex((c) => c.id === over.columnId)
  return toIndex < 0 ? null : { columnId: from.columnId, toIndex }
}
