/**
 * A task layout → the horizontal panel strip: which columns take width, their
 * resolved px widths, flex order, resize-handle neighbours and the anchor gap.
 * Each visible column is one strip entry keyed by its column id, resolved by the
 * same `resolveLayout`/`planPanelStrip` the legacy strip used. Classic column ids
 * are the legacy panel ids, so Classic resolves exactly as before.
 */
import type {
  LayoutColumn,
  LayoutSlot,
  LayoutTab,
  PanelInstance,
  PanelKind,
  PanelLayout,
  TaskLayout
} from '@slayzone/task-contracts'
import {
  columnEffectiveLayout,
  findTab,
  isColumnVisible,
  isSlotVisible
} from '@slayzone/task-contracts'
import {
  planPanelStrip,
  resolveLayout,
  type PanelStripPlan,
  type ResolvedLayout
} from '../usePanelSizes'

export interface LayoutStrip {
  /** Columns that take width (any visible group), in layout (visual) order. */
  columns: LayoutColumn[]
  /** Effective layout (default size ◀ override) per visible column id. */
  layouts: Record<string, PanelLayout>
  resolved: ResolvedLayout
  plan: PanelStripPlan
}

export function resolveLayoutStrip(layout: TaskLayout, containerWidth: number): LayoutStrip {
  const columns = layout.columns.filter(isColumnVisible)
  const layouts: Record<string, PanelLayout> = {}
  for (const column of columns) layouts[column.id] = columnEffectiveLayout(column)
  const resolved = resolveLayout(
    columns.map((c) => ({ key: c.id, layout: layouts[c.id] })),
    containerWidth
  )
  return { columns, layouts, resolved, plan: planPanelStrip(resolved) }
}

/** The kind of a column's first tab (what the column shows when it holds one panel). */
export function columnKind(layout: TaskLayout, column: LayoutColumn): PanelKind | null {
  const id = column.slots[0]?.tabs[0]?.instanceId
  return id ? (layout.instances[id]?.kind ?? null) : null
}

/** DOM rank per kind: the legacy strip's fixed JSX order (web panels between artifacts and git). */
const DOM_RANK: Partial<Record<PanelKind, number>> = {
  agent: 0,
  browser: 1,
  editor: 2,
  artifacts: 3,
  web: 4,
  git: 5,
  settings: 6,
  processes: 7
}

/**
 * Columns in a STABLE DOM order; their visual order comes from flex `order`.
 * Reordering panels must not move DOM nodes (a moved subtree loses focus, and a
 * moved <webview> reloads), so the DOM keeps the legacy strip's fixed order: by
 * kind, web panels by their place in `webPanelIds`, anything else after, in
 * layout order.
 */
export function domOrderedColumns(
  layout: TaskLayout,
  columns: readonly LayoutColumn[],
  webPanelIds: readonly string[]
): LayoutColumn[] {
  const rank = (column: LayoutColumn, index: number): [number, number] => {
    const kind = columnKind(layout, column)
    const base = kind ? (DOM_RANK[kind] ?? 8) : 8
    if (kind === 'web') {
      const at = webPanelIds.indexOf(column.slots[0].tabs[0].instanceId)
      return [base, at < 0 ? webPanelIds.length + index : at]
    }
    return [base, index]
  }
  return columns
    .map((column, index) => ({ column, key: rank(column, index) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1])
    .map((e) => e.column)
}

/** The primary agent's id: the one panel an explode-mode (compact) cell shows. */
const COMPACT_INSTANCE_ID = 'terminal'

/**
 * Compact (explode-mode) cell: just the column holding the primary agent, reduced
 * to that one shown tab whatever its visibility, like the legacy compact cell.
 * Null when the layout holds no primary agent.
 */
export function compactColumns(layout: TaskLayout): LayoutColumn[] | null {
  const loc = findTab(layout, COMPACT_INSTANCE_ID)
  if (!loc) return null
  const column = layout.columns[loc.columnIndex]
  const slot = column.slots[loc.slotIndex]
  return [
    {
      ...column,
      slots: [
        {
          id: slot.id,
          weight: 1,
          activeInstanceId: COMPACT_INSTANCE_ID,
          tabs: [{ instanceId: COMPACT_INSTANCE_ID }]
        }
      ]
    }
  ]
}

/** A group's tabs that render: shown, with an instance the layout holds. */
export function renderedTabs(layout: TaskLayout, slot: LayoutSlot): LayoutTab[] {
  return slot.tabs.filter((t) => !t.hidden && layout.instances[t.instanceId])
}

/** The tab a group shows: its active one while rendered, else its first rendered tab. */
export function shownTabOf(layout: TaskLayout, slot: LayoutSlot): string | undefined {
  const tabs = renderedTabs(layout, slot)
  return tabs.find((t) => t.instanceId === slot.activeInstanceId)?.instanceId ?? tabs[0]?.instanceId
}

/**
 * A column showing just the panel it is named after (every Classic column): it
 * renders that panel bare, the panel's frame taking the column's width and order.
 */
export function isBareColumn(column: LayoutColumn): boolean {
  const slots = column.slots.filter(isSlotVisible)
  if (slots.length !== 1 || slots[0].name) return false
  const shown = slots[0].tabs.filter((t) => !t.hidden)
  return shown.length === 1 && shown[0].instanceId === column.id
}

/** Where one rendered panel instance sits (see `placePanels`). */
export interface PanelPlacement {
  instance: PanelInstance
  /** The tab its group shows. The others stay mounted out of view, their page inactive. */
  active: boolean
  /** Fills a layout cell (a stacked group or a tab strip's body) rather than taking a strip column's width and order. */
  inCell: boolean
}

/**
 * Every panel instance the layout renders right now, with what its frame needs to
 * know about its place. The column tree renders a target per placement and the
 * panels render ONCE each, keyed by instance id, into their target (TaskLayoutView):
 * moving a tab to another group moves its DOM, it never remounts the panel.
 */
export function placePanels(
  layout: TaskLayout,
  columns: readonly LayoutColumn[],
  compact: boolean
): PanelPlacement[] {
  const out: PanelPlacement[] = []
  for (const column of columns) {
    const slots = column.slots.filter(isSlotVisible)
    if (slots.length === 0) continue
    if (compact || isBareColumn(column)) {
      const shown = shownTabOf(layout, slots[0])
      if (shown) out.push({ instance: layout.instances[shown], active: true, inCell: false })
      continue
    }
    for (const slot of slots) {
      const shown = shownTabOf(layout, slot)
      if (!shown) continue
      if (!showsTabStrip(slot)) {
        out.push({ instance: layout.instances[shown], active: true, inCell: true })
        continue
      }
      for (const t of renderedTabs(layout, slot))
        out.push({
          instance: layout.instances[t.instanceId],
          active: t.instanceId === shown,
          inCell: true
        })
    }
  }
  return out
}

/** A group shows a tab strip: it is named, or more than one of its tabs is shown. */
export function showsTabStrip(slot: LayoutSlot): boolean {
  return !!slot.name || slot.tabs.filter((t) => !t.hidden).length > 1
}

/** The instance is a shown tab of a shown group that has a tab strip (⌘W closes it). */
export function isInTabStrip(layout: TaskLayout, instanceId: string): boolean {
  const loc = findTab(layout, instanceId)
  if (!loc) return false
  const slot = layout.columns[loc.columnIndex].slots[loc.slotIndex]
  return !slot.hidden && !slot.tabs[loc.tabIndex].hidden && showsTabStrip(slot)
}
