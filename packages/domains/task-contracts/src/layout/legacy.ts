/**
 * Compatibility with the legacy per-task panel columns (docs/plans/panel-model.md
 * §1.3–1.4): `panel_visibility` ↔ hidden on the group holding primary instance
 * `{id}`, `panel_sizes.{id}` ↔ the size override of a column whose only (non-hidden)
 * tab is primary `{id}`.
 *
 * - `deriveLayoutFromLegacy`: the layout today's task page renders, from the old columns.
 * - `projectToLegacy`: a layout → the old columns (the hub dual-writes them).
 * - `applyLegacyWrite`: an old client's legacy-only write → the layout.
 */
import { mergePanelOrder } from '../panel-config'
import type { PanelConfig, PanelSizeOverride, PanelSizes, PanelVisibility } from '../types'
import { BUILTIN_PANEL_IDS, isPanelEnabled, orderIdToTaskId, taskIdToOrderId } from '../types'
import {
  appendColumnDraft,
  findTab,
  finishDraft,
  instanceDefaultLayout,
  isInstanceVisible,
  legacyIdOf,
  legacyKindOf,
  panelDefaultLayout,
  type OpContext
} from './ops'
import { parsePanelSizes } from './settings'
import {
  CLASSIC_LAYOUT_ID,
  type LayoutColumn,
  type LayoutTree,
  type LegacyPanelState,
  type PanelInstance,
  type TaskLayout
} from './types'

/** A task with no stored visibility shows the agent and settings. */
export const DEFAULT_TASK_PANEL_VISIBILITY: PanelVisibility = {
  terminal: true,
  browser: false,
  diff: false,
  settings: true,
  editor: false,
  artifacts: false,
  processes: false
}

/** A secondary task window starts with every panel hidden (its visibility is local). */
export const SECONDARY_WINDOW_PANEL_VISIBILITY: PanelVisibility = {
  terminal: false,
  browser: false,
  diff: false,
  settings: false,
  editor: false,
  artifacts: false,
  processes: false
}

/** The task fields the legacy panel model lives in. */
export interface LegacyTaskPanels {
  panel_visibility?: Record<string, boolean> | null
  panel_sizes?: unknown
  is_temporary?: boolean
}

/** Today's resolvePanelVisibility: defaults ◀ stored ◀ temporary tasks never show settings. */
export function resolveLegacyPanelVisibility(task: LegacyTaskPanels): PanelVisibility {
  const stored = task.panel_visibility
  return {
    ...DEFAULT_TASK_PANEL_VISIBILITY,
    ...(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}),
    ...(task.is_temporary ? { settings: false } : {})
  }
}

function primaryInstance(id: string): PanelInstance | null {
  const kind = legacyKindOf(id)
  if (!kind) return null
  return { id, kind, settings: kind === 'web' ? { panelId: id } : {} }
}

/**
 * One column per panel in `panel_config.order` (task ids, `git` → `diff`) that
 * `include(enabled, visible)` keeps, ids = legacy ids, sizes = today's defaults.
 */
export function legacyPanelColumns(
  config: PanelConfig,
  visibility: Record<string, boolean>,
  sizes: PanelSizes,
  include: (enabled: boolean, visible: boolean) => boolean
): LayoutTree {
  const merged = mergePanelOrder({ ...config, webPanels: config.webPanels ?? [] })
  const columns: LayoutColumn[] = []
  const instances: Record<string, PanelInstance> = {}
  for (const orderId of merged.order ?? []) {
    const id = orderIdToTaskId(orderId)
    const inst = primaryInstance(id)
    if (!inst || id in instances) continue
    const visible = Boolean(visibility[id])
    if (!include(isPanelEnabled(merged, id, 'task'), visible)) continue
    instances[id] = inst
    const column: LayoutColumn = {
      id,
      size: panelDefaultLayout(taskIdToOrderId(id), config),
      slots: [
        {
          id,
          ...(visible ? {} : { hidden: true }),
          weight: 1,
          activeInstanceId: id,
          tabs: [{ instanceId: id }]
        }
      ]
    }
    if (sizes[id]) column.sizeOverride = { ...sizes[id] }
    columns.push(column)
  }
  return { columns, instances }
}

/**
 * The layout today's task page renders for `task`: Classic from `panelConfig`
 * (every enabled panel, plus any disabled panel still marked visible — today it
 * keeps its place in the strip), hidden per the resolved visibility, sized by
 * `panel_sizes`. A secondary window starts with everything hidden.
 */
export function deriveLayoutFromLegacy(
  task: LegacyTaskPanels,
  panelConfig: PanelConfig,
  opts: { secondaryWindow?: boolean } = {}
): TaskLayout {
  const visibility = opts.secondaryWindow
    ? SECONDARY_WINDOW_PANEL_VISIBILITY
    : resolveLegacyPanelVisibility(task)
  const tree = legacyPanelColumns(
    panelConfig,
    visibility,
    parsePanelSizes(task.panel_sizes),
    (enabled, visible) => enabled || visible
  )
  return { v: 1, rev: 0, layoutId: CLASSIC_LAYOUT_ID, ...tree }
}

/** Legacy ids of the layout's primary instances. */
function ownedLegacyIds(layout: LayoutTree): string[] {
  const out: string[] = []
  for (const inst of Object.values(layout.instances)) {
    const id = legacyIdOf(inst)
    if (id) out.push(id)
  }
  return out
}

/** The legacy id a column's size maps to: its only non-hidden tab, when that is a primary. */
function columnLegacyId(layout: LayoutTree, column: LayoutColumn): string | null {
  const tabs = column.slots.flatMap((s) => s.tabs.filter((t) => !t.hidden))
  if (tabs.length !== 1) return null
  const inst = layout.instances[tabs[0].instanceId]
  return inst ? legacyIdOf(inst) : null
}

/**
 * A layout → `panel_visibility` + `panel_sizes`. Every built-in panel id is
 * reported (absent from the layout = hidden). Keys the layout does not own (a
 * web panel it lacks, `tests`) are kept from `base`, so a dual-write never drops
 * an older client's data.
 */
export function projectToLegacy(
  layout: LayoutTree,
  base: Partial<LegacyPanelState> = {}
): { panelVisibility: PanelVisibility; panelSizes: PanelSizes } {
  const owned = ownedLegacyIds(layout)
  const panelVisibility: Record<string, boolean> = { ...(base.panelVisibility ?? {}) }
  for (const id of BUILTIN_PANEL_IDS) panelVisibility[id] = false
  for (const id of owned) panelVisibility[id] = isInstanceVisible(layout, id)

  const panelSizes: PanelSizes = { ...parsePanelSizes(base.panelSizes) }
  for (const id of owned) delete panelSizes[id]
  for (const column of layout.columns) {
    const id = columnLegacyId(layout, column)
    if (id && column.sizeOverride) panelSizes[id] = { ...column.sizeOverride }
  }
  return { panelVisibility: panelVisibility as PanelVisibility, panelSizes }
}

function sameSize(a: PanelSizeOverride | undefined, b: PanelSizeOverride | undefined): boolean {
  return a?.unit === b?.unit && a?.value === b?.value
}

/**
 * Apply an old client's legacy-only write. Visibility keys toggle the group (or,
 * when it shares the group with other visible tabs, just the tab) of their
 * primary instance in place; showing a panel the layout lacks appends it as a
 * column (no column cap — the old app's strip is flat). `panelSizes` replaces the
 * overrides of every column it maps to. Unknown ids are ignored. Returns the same
 * object when nothing changed, else a new one with rev + 1.
 */
export function applyLegacyWrite<T extends LayoutTree>(
  layout: T,
  write: { panelVisibility?: Record<string, boolean> | null; panelSizes?: unknown },
  ctx: OpContext = {}
): T {
  const draft = structuredClone(layout)
  let changed = false

  const vis = write.panelVisibility
  if (vis && typeof vis === 'object')
    for (const [id, want] of Object.entries(vis)) {
      if (typeof want !== 'boolean') continue
      const existing = draft.instances[id]
      if (existing) {
        if (legacyIdOf(existing) !== id) continue
        const loc = findTab(draft, id)
        if (!loc) continue
        const slot = draft.columns[loc.columnIndex].slots[loc.slotIndex]
        const tab = slot.tabs[loc.tabIndex]
        const visible = !slot.hidden && !tab.hidden
        if (want === visible) continue
        changed = true
        if (want) {
          delete slot.hidden
          delete tab.hidden
          slot.activeInstanceId = id
        } else if (slot.tabs.some((t) => t !== tab && !t.hidden)) {
          tab.hidden = true
          if (slot.activeInstanceId === id)
            slot.activeInstanceId = slot.tabs.find((t) => !t.hidden)?.instanceId ?? id
        } else slot.hidden = true
      } else if (want) {
        const inst = primaryInstance(id)
        if (!inst) continue
        appendColumnDraft(draft, inst, instanceDefaultLayout(inst.kind, inst.settings), ctx)
        changed = true
      }
    }

  if (write.panelSizes !== undefined) {
    const sizes = parsePanelSizes(write.panelSizes)
    for (const column of draft.columns) {
      const id = columnLegacyId(draft, column)
      if (!id || sameSize(column.sizeOverride, sizes[id])) continue
      changed = true
      if (sizes[id]) column.sizeOverride = { ...sizes[id] }
      else delete column.sizeOverride
    }
  }

  return changed ? finishDraft(draft) : layout
}
