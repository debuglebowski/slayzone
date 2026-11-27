/**
 * Pure layout operations (docs/plans/panel-model.md §1.1).
 *
 * Every op takes a layout tree (a TaskLayout, or a LayoutDefinition in the editor),
 * returns a NEW object, never mutates its input, bumps `rev` when the tree has one,
 * and leaves the tree normalized (see `normalizeLayoutTree`). Unknown ids are
 * no-ops apart from the rev bump. Tabs are addressed by instance id (unique in a
 * layout), slots and columns by their own ids.
 */
import type { PanelConfig, PanelLayout, PanelSizeOverride } from '../types'
import { coerceBound, panelLayoutFallback } from '../types'
import { normalizeLayoutTree, parseInstanceSettings, parseSizeOverride } from './settings'
import {
  MAX_LAYOUT_COLUMNS,
  PRIMARY_INSTANCE_IDS,
  type InstancePlacement,
  type LayoutColumn,
  type LayoutSlot,
  type LayoutTab,
  type LayoutTree,
  type PanelInstance,
  type PanelInstanceSettings,
  type PanelKind,
  type SplitZone,
  type TabDropTarget
} from './types'

/** Source of fresh 8-hex-char ids; injectable so tests are deterministic. */
export interface OpContext {
  newId?: () => string
}

function randomId8(): string {
  return globalThis.crypto.randomUUID().slice(0, 8)
}

// ── Identity ─────────────────────────────────────────────────────────────────

const LEGACY_ID_KINDS: Record<string, PanelKind> = Object.fromEntries(
  Object.entries(PRIMARY_INSTANCE_IDS).map(([kind, id]) => [id, kind as PanelKind])
)

/** The kind a legacy panel id (`panel_visibility` key) maps to, or null (`tests`, junk). */
export function legacyKindOf(legacyId: string): PanelKind | null {
  if (legacyId.startsWith('web:') && legacyId.length > 4) return 'web'
  return LEGACY_ID_KINDS[legacyId] ?? null
}

/** The legacy panel id this instance stands for, or null when it is not a primary instance. */
export function legacyIdOf(inst: PanelInstance): string | null {
  if (inst.kind === 'web') return inst.settings.panelId === inst.id ? inst.id : null
  const primary = PRIMARY_INSTANCE_IDS[inst.kind]
  return primary !== undefined && primary === inst.id ? inst.id : null
}

export function isPrimaryInstance(inst: PanelInstance): boolean {
  return legacyIdOf(inst) !== null
}

/**
 * The id for a new instance of `kind`: its legacy id while no instance holds it
 * (for `web`, the `settings.panelId` web panel id), else `<kind>:<uuid8>`.
 */
export function newInstanceId(
  tree: LayoutTree,
  kind: PanelKind,
  settings: PanelInstanceSettings = {},
  ctx: OpContext = {}
): string {
  const primary =
    kind === 'web'
      ? typeof settings.panelId === 'string' && settings.panelId.startsWith('web:')
        ? settings.panelId
        : undefined
      : PRIMARY_INSTANCE_IDS[kind]
  if (primary !== undefined && !(primary in tree.instances)) return primary
  const gen = ctx.newId ?? randomId8
  for (;;) {
    const id = `${kind}:${gen()}`
    if (!(id in tree.instances)) return id
  }
}

// ── Sizes ────────────────────────────────────────────────────────────────────

/** The panel_config `order`/`layout` id whose default size a kind uses. */
const KIND_SIZE_IDS: Record<PanelKind, string> = {
  agent: 'terminal',
  terminal: 'terminal',
  browser: 'browser',
  web: 'web',
  editor: 'editor',
  artifacts: 'artifacts',
  artifact: 'artifacts',
  git: 'git',
  processes: 'processes',
  settings: 'settings',
  description: 'settings',
  subtasks: 'settings',
  details: 'settings'
}

/**
 * Default layout for a panel_config order id: hardcoded fallback ◀
 * `panel_config.layout[orderId]`, bounds coerced — the base of `effectiveLayout`.
 */
export function panelDefaultLayout(orderId: string, config?: PanelConfig | null): PanelLayout {
  const base: PanelLayout = {
    ...panelLayoutFallback(orderId),
    ...(config?.layout?.[orderId] ?? {})
  }
  const min = coerceBound(base.min)
  const max = coerceBound(base.max)
  delete base.min
  delete base.max
  if (min) base.min = min
  if (max) base.max = max
  return base
}

/** Default column size for an instance (web panels use their own layout entry). */
export function instanceDefaultLayout(
  kind: PanelKind,
  settings: PanelInstanceSettings = {},
  config?: PanelConfig | null
): PanelLayout {
  const webId = kind === 'web' && typeof settings.panelId === 'string' ? settings.panelId : null
  return panelDefaultLayout(webId ?? KIND_SIZE_IDS[kind], config)
}

/** A column's rendered layout = `size` with the override's unit/value, like `effectiveLayout`. */
export function columnEffectiveLayout(column: LayoutColumn): PanelLayout {
  const ov = column.sizeOverride
  return ov ? { ...column.size, unit: ov.unit, value: ov.value } : column.size
}

// ── Queries ──────────────────────────────────────────────────────────────────

export interface TabLocation {
  columnIndex: number
  slotIndex: number
  tabIndex: number
}

export function findTab(tree: LayoutTree, instanceId: string): TabLocation | null {
  for (const [columnIndex, column] of tree.columns.entries())
    for (const [slotIndex, slot] of column.slots.entries()) {
      const tabIndex = slot.tabs.findIndex((t) => t.instanceId === instanceId)
      if (tabIndex >= 0) return { columnIndex, slotIndex, tabIndex }
    }
  return null
}

export function findSlot(
  tree: LayoutTree,
  slotId: string
): { columnIndex: number; slotIndex: number } | null {
  for (const [columnIndex, column] of tree.columns.entries()) {
    const slotIndex = column.slots.findIndex((s) => s.id === slotId)
    if (slotIndex >= 0) return { columnIndex, slotIndex }
  }
  return null
}

/** A slot shows something: not hidden and at least one visible tab. */
export function isSlotVisible(slot: LayoutSlot): boolean {
  return !slot.hidden && slot.tabs.some((t) => !t.hidden)
}

/** A column takes width when any of its slots is visible. */
export function isColumnVisible(column: LayoutColumn): boolean {
  return column.slots.some(isSlotVisible)
}

/** An instance is shown (or one click away in its tab strip): its slot and tab are not hidden. */
export function isInstanceVisible(tree: LayoutTree, instanceId: string): boolean {
  const loc = findTab(tree, instanceId)
  if (!loc) return false
  const slot = tree.columns[loc.columnIndex].slots[loc.slotIndex]
  return !slot.hidden && !slot.tabs[loc.tabIndex].hidden
}

// ── Draft helpers (mutate a private clone) ───────────────────────────────────

function edit<T extends LayoutTree>(tree: T, fn: (draft: T) => void): T {
  const draft = structuredClone(tree)
  fn(draft)
  return finish(draft)
}

/** Normalize a draft in place and bump its rev (when it has one). */
function finish<T extends LayoutTree>(draft: T): T {
  const { columns, instances } = normalizeLayoutTree(draft.columns, draft.instances)
  draft.columns = columns
  draft.instances = instances
  const withRev = draft as T & { rev?: unknown }
  if (typeof withRev.rev === 'number') withRev.rev += 1
  return draft
}

/** Point `slot` at a visible neighbour of the tab at `index` (called before removing/hiding it). */
function activateNeighbour(slot: LayoutSlot, index: number): void {
  const others = slot.tabs.filter((_, i) => i !== index)
  const after = slot.tabs.slice(index + 1).find((t) => !t.hidden)
  const before = slot.tabs
    .slice(0, index)
    .reverse()
    .find((t) => !t.hidden)
  slot.activeInstanceId = (after ?? before ?? others[0])?.instanceId ?? null
}

/** Remove a tab (not its instance); empty slots stay until `finish` prunes them. */
function takeTab(draft: LayoutTree, instanceId: string): LayoutTab | null {
  const loc = findTab(draft, instanceId)
  if (!loc) return null
  const slot = draft.columns[loc.columnIndex].slots[loc.slotIndex]
  if (slot.activeInstanceId === instanceId) activateNeighbour(slot, loc.tabIndex)
  return slot.tabs.splice(loc.tabIndex, 1)[0]
}

function columnHasTabs(column: LayoutColumn): boolean {
  return column.slots.some((s) => s.tabs.length > 0)
}

function newSlot(tab: LayoutTab, ctx: OpContext, weight = 1): LayoutSlot {
  return {
    id: `slot:${(ctx.newId ?? randomId8)()}`,
    weight,
    activeInstanceId: tab.instanceId,
    tabs: [tab]
  }
}

function newColumn(tab: LayoutTab, size: PanelLayout, ctx: OpContext): LayoutColumn {
  return {
    id: `column:${(ctx.newId ?? randomId8)()}`,
    size: { ...size },
    slots: [newSlot(tab, ctx)]
  }
}

/** Insert `tab` beside `slotId` (a sibling column or a stacked slot). False when the slot is unknown. */
function insertSplit(
  draft: LayoutTree,
  tab: LayoutTab,
  slotId: string,
  zone: SplitZone,
  size: PanelLayout,
  ctx: OpContext,
  maxColumns: number
): boolean {
  const loc = findSlot(draft, slotId)
  if (!loc) return false
  let z = zone
  if ((z === 'left' || z === 'right') && draft.columns.filter(columnHasTabs).length >= maxColumns)
    z = z === 'left' ? 'before' : 'after'
  if (z === 'left' || z === 'right') {
    draft.columns.splice(loc.columnIndex + (z === 'right' ? 1 : 0), 0, newColumn(tab, size, ctx))
    return true
  }
  const column = draft.columns[loc.columnIndex]
  const target = column.slots[loc.slotIndex]
  const half = target.weight / 2
  target.weight = half
  column.slots.splice(loc.slotIndex + (z === 'after' ? 1 : 0), 0, newSlot(tab, ctx, half))
  return true
}

/** Insert `tab` into an existing slot and show it. False when the slot is unknown. */
function insertIntoSlot(
  draft: LayoutTree,
  tab: LayoutTab,
  slotId: string,
  index?: number
): boolean {
  const loc = findSlot(draft, slotId)
  if (!loc) return false
  const slot = draft.columns[loc.columnIndex].slots[loc.slotIndex]
  const at = index === undefined ? slot.tabs.length : Math.max(0, Math.min(index, slot.tabs.length))
  slot.tabs.splice(at, 0, tab)
  slot.activeInstanceId = tab.instanceId
  return true
}

/** Append `tab` as a new column at `index`; beyond `maxColumns`, as a new slot in the last column. */
function insertColumn(
  draft: LayoutTree,
  tab: LayoutTab,
  size: PanelLayout,
  ctx: OpContext,
  index: number | undefined,
  maxColumns: number
): void {
  const filled = draft.columns.filter(columnHasTabs)
  if (filled.length >= maxColumns) {
    filled[filled.length - 1].slots.push(newSlot(tab, ctx))
    return
  }
  const at =
    index === undefined ? draft.columns.length : Math.max(0, Math.min(index, draft.columns.length))
  draft.columns.splice(at, 0, newColumn(tab, size, ctx))
}

/** Size for a column a moved tab opens: its old column's when it leaves that column empty. */
function movedTabSize(draft: LayoutTree, instanceId: string): PanelLayout {
  const loc = findTab(draft, instanceId)
  const inst = draft.instances[instanceId]
  if (loc) {
    const column = draft.columns[loc.columnIndex]
    const tabs = column.slots.reduce((n, s) => n + s.tabs.length, 0)
    if (tabs === 1) return column.size
  }
  return inst ? instanceDefaultLayout(inst.kind, inst.settings) : { unit: 'fr', value: 1 }
}

// ── Ops ──────────────────────────────────────────────────────────────────────

/** Move a tab into `slotId` at `index` (default end) and show it there. Same slot = reorder. */
export function mergeInto<T extends LayoutTree>(
  tree: T,
  instanceId: string,
  slotId: string,
  index?: number
): T {
  return edit(tree, (d) => {
    const loc = findTab(d, instanceId)
    const target = findSlot(d, slotId)
    if (!loc || !target) return
    let at = index
    // Indices address the slot as it is now; removing an earlier tab of the same slot shifts them.
    if (
      at !== undefined &&
      loc.columnIndex === target.columnIndex &&
      loc.slotIndex === target.slotIndex
    )
      at = at > loc.tabIndex ? at - 1 : at
    const tab = takeTab(d, instanceId)
    if (tab) insertIntoSlot(d, tab, slotId, at)
  })
}

/**
 * Split a tab off as its own group beside `slotId`: `left`/`right` = a new column,
 * `before`/`after` = a new slot above/below (halving the target's weight). At the
 * column limit, `left`/`right` become `before`/`after`.
 */
export function splitAt<T extends LayoutTree>(
  tree: T,
  instanceId: string,
  slotId: string,
  zone: SplitZone,
  ctx: OpContext = {}
): T {
  return edit(tree, (d) => {
    if (!findTab(d, instanceId) || !findSlot(d, slotId)) return
    const size = movedTabSize(d, instanceId)
    const tab = takeTab(d, instanceId)
    if (tab) insertSplit(d, tab, slotId, zone, size, ctx, MAX_LAYOUT_COLUMNS)
  })
}

/** A tab drop: merge into a group, or split beside it. */
export function moveTab<T extends LayoutTree>(
  tree: T,
  instanceId: string,
  target: TabDropTarget,
  ctx: OpContext = {}
): T {
  return target.type === 'merge'
    ? mergeInto(tree, instanceId, target.slotId, target.index)
    : splitAt(tree, instanceId, target.slotId, target.zone, ctx)
}

/**
 * Move a whole group (with its hidden tabs, name and active tab): `merge` appends
 * its tabs to another group at `index` (default end) and shows its active tab
 * there; `split` places it beside another group like `splitAt`. A target in the
 * group itself is a no-op (apart from the rev bump).
 */
export function moveSlot<T extends LayoutTree>(
  tree: T,
  slotId: string,
  target: TabDropTarget,
  ctx: OpContext = {}
): T {
  return edit(tree, (d) => {
    const from = findSlot(d, slotId)
    if (!from || target.slotId === slotId || !findSlot(d, target.slotId)) return
    const column = d.columns[from.columnIndex]
    const slot = column.slots[from.slotIndex]
    if (target.type === 'merge') {
      const to = findSlot(d, target.slotId)
      if (!to) return
      const dest = d.columns[to.columnIndex].slots[to.slotIndex]
      const at =
        target.index === undefined
          ? dest.tabs.length
          : Math.max(0, Math.min(target.index, dest.tabs.length))
      dest.tabs.splice(at, 0, ...slot.tabs)
      const shown = slot.tabs.find((t) => t.instanceId === slot.activeInstanceId && !t.hidden)
      if (shown && !slot.hidden) dest.activeInstanceId = shown.instanceId
      slot.tabs = []
      return
    }
    // The group leaves its column; a column it empties lends its size to the new one.
    const size =
      column.slots.length === 1
        ? column.size
        : (() => {
            const inst = slot.activeInstanceId ? d.instances[slot.activeInstanceId] : undefined
            return inst ? instanceDefaultLayout(inst.kind, inst.settings) : column.size
          })()
    column.slots.splice(from.slotIndex, 1)
    insertSlotSplit(d, { ...slot, weight: 1 }, target.slotId, target.zone, size, ctx)
  })
}

/**
 * Move a whole column (its groups, sizes and hidden state) to `toIndex` among the
 * columns (clamped): the title row's group toggles reorder columns by drag.
 */
export function moveColumn<T extends LayoutTree>(tree: T, columnId: string, toIndex: number): T {
  return edit(tree, (d) => {
    const from = d.columns.findIndex((c) => c.id === columnId)
    if (from < 0) return
    const [column] = d.columns.splice(from, 1)
    d.columns.splice(Math.max(0, Math.min(toIndex, d.columns.length)), 0, column)
  })
}

/** Place an existing group beside `slotId` (a sibling column or a stacked slot). */
function insertSlotSplit(
  draft: LayoutTree,
  slot: LayoutSlot,
  slotId: string,
  zone: SplitZone,
  size: PanelLayout,
  ctx: OpContext
): void {
  const loc = findSlot(draft, slotId)
  if (!loc) return
  let z = zone
  if (
    (z === 'left' || z === 'right') &&
    draft.columns.filter(columnHasTabs).length >= MAX_LAYOUT_COLUMNS
  )
    z = z === 'left' ? 'before' : 'after'
  if (z === 'left' || z === 'right') {
    draft.columns.splice(loc.columnIndex + (z === 'right' ? 1 : 0), 0, {
      id: `column:${(ctx.newId ?? randomId8)()}`,
      size: { ...size },
      slots: [slot]
    })
    return
  }
  const column = draft.columns[loc.columnIndex]
  const targetSlot = column.slots[loc.slotIndex]
  const half = targetSlot.weight / 2
  targetSlot.weight = half
  column.slots.splice(loc.slotIndex + (z === 'after' ? 1 : 0), 0, { ...slot, weight: half })
}

/** Move a tab to `toIndex` within its own slot (clamped). */
export function reorderTab<T extends LayoutTree>(tree: T, instanceId: string, toIndex: number): T {
  return edit(tree, (d) => {
    const loc = findTab(d, instanceId)
    if (!loc) return
    const tabs = d.columns[loc.columnIndex].slots[loc.slotIndex].tabs
    const [tab] = tabs.splice(loc.tabIndex, 1)
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab)
  })
}

/** Show a tab in its slot (unhiding the tab). */
export function setActiveTab<T extends LayoutTree>(tree: T, instanceId: string): T {
  return edit(tree, (d) => {
    const loc = findTab(d, instanceId)
    if (!loc) return
    const slot = d.columns[loc.columnIndex].slots[loc.slotIndex]
    delete slot.tabs[loc.tabIndex].hidden
    delete slot.tabs[loc.tabIndex].parked
    slot.activeInstanceId = instanceId
  })
}

/**
 * Hide or show a group in place. Showing a hidden group clears its column's size
 * override, like opening a panel resets its size today.
 */
export function setSlotHidden<T extends LayoutTree>(tree: T, slotId: string, hidden: boolean): T {
  return edit(tree, (d) => {
    const loc = findSlot(d, slotId)
    if (!loc) return
    const column = d.columns[loc.columnIndex]
    const slot = column.slots[loc.slotIndex]
    if (hidden) slot.hidden = true
    else if (slot.hidden) {
      delete slot.hidden
      delete column.sizeOverride
    }
  })
}

/** Hide or show a tab in place. Hiding the active tab shows a neighbour; showing a tab activates it. */
export function setTabHidden<T extends LayoutTree>(
  tree: T,
  instanceId: string,
  hidden: boolean
): T {
  return edit(tree, (d) => {
    const loc = findTab(d, instanceId)
    if (!loc) return
    const slot = d.columns[loc.columnIndex].slots[loc.slotIndex]
    const tab = slot.tabs[loc.tabIndex]
    if (hidden) {
      tab.hidden = true
      if (slot.activeInstanceId === instanceId) activateNeighbour(slot, loc.tabIndex)
    } else {
      delete tab.hidden
      delete tab.parked
      slot.activeInstanceId = instanceId
    }
  })
}

/** Remove an instance and its tab; empty groups and columns go with it. */
export function closeInstance<T extends LayoutTree>(tree: T, instanceId: string): T {
  return edit(tree, (d) => {
    takeTab(d, instanceId)
    delete d.instances[instanceId]
  })
}

/**
 * Hide a tab, keeping its place: the last shown tab of a group hides the whole
 * group instead (what `panel_visibility` maps to), so showing the panel again
 * brings its group back as it was.
 */
export function hideTab<T extends LayoutTree>(tree: T, instanceId: string): T {
  const loc = findTab(tree, instanceId)
  if (!loc) return normalizeLayout(tree)
  const slot = tree.columns[loc.columnIndex].slots[loc.slotIndex]
  const othersShown = slot.tabs.some((t) => t.instanceId !== instanceId && !t.hidden)
  return othersShown ? setTabHidden(tree, instanceId, true) : setSlotHidden(tree, slot.id, true)
}

/**
 * Close a tab. A primary (legacy-id) instance is only hidden (`hideTab`): legacy
 * clients, shortcuts and ownership address it by that id and expect it to exist.
 * Any other instance is removed (`closeInstance`).
 */
export function closeTab<T extends LayoutTree>(tree: T, instanceId: string): T {
  const inst = tree.instances[instanceId]
  if (inst && isPrimaryInstance(inst)) return hideTab(tree, instanceId)
  return closeInstance(tree, instanceId)
}

/** Name an instance (its tab label); blank or undefined = the kind's label. */
export function renameInstance<T extends LayoutTree>(
  tree: T,
  instanceId: string,
  name: string | undefined
): T {
  return edit(tree, (d) => {
    const inst = d.instances[instanceId]
    if (!inst) return
    const trimmed = name?.trim()
    if (trimmed) inst.name = trimmed
    else delete inst.name
  })
}

/**
 * Merge `patch` into an instance's settings (undefined values delete keys), then
 * re-validate them for its kind like a parsed layout would.
 */
export function updateInstanceSettings<T extends LayoutTree>(
  tree: T,
  instanceId: string,
  patch: Record<string, unknown>
): T {
  return edit(tree, (d) => {
    const inst = d.instances[instanceId]
    if (!inst) return
    const next: Record<string, unknown> = { ...inst.settings }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k]
      else next[k] = v
    }
    inst.settings = parseInstanceSettings(inst.kind, next)
  })
}

/** Name a group; blank or undefined = unnamed. */
export function renameSlot<T extends LayoutTree>(
  tree: T,
  slotId: string,
  name: string | undefined
): T {
  return edit(tree, (d) => {
    const loc = findSlot(d, slotId)
    if (!loc) return
    const slot = d.columns[loc.columnIndex].slots[loc.slotIndex]
    const trimmed = name?.trim()
    if (trimmed) slot.name = trimmed
    else delete slot.name
  })
}

/** Set (or clear with null) column size overrides, keyed by column id. Invalid sizes are ignored. */
export function resizeColumns<T extends LayoutTree>(
  tree: T,
  overrides: Record<string, PanelSizeOverride | null>
): T {
  return edit(tree, (d) => {
    for (const column of d.columns) {
      if (!Object.prototype.hasOwnProperty.call(overrides, column.id)) continue
      const next = overrides[column.id]
      if (next === null) delete column.sizeOverride
      else {
        const parsed = parseSizeOverride(next)
        if (parsed) column.sizeOverride = parsed
      }
    }
  })
}

/** Set slot weights within a column; only positive finite weights apply. */
export function resizeSlots<T extends LayoutTree>(
  tree: T,
  columnId: string,
  weights: Record<string, number>
): T {
  return edit(tree, (d) => {
    const column = d.columns.find((c) => c.id === columnId)
    if (!column) return
    for (const slot of column.slots) {
      const w = weights[slot.id]
      if (typeof w === 'number' && Number.isFinite(w) && w > 0) slot.weight = w
    }
  })
}

export interface AddInstanceOptions extends OpContext {
  /** Use this id if no instance holds it (else the primary rule applies). */
  id?: string
  name?: string
  settings?: unknown
  /** Size of a new column (default: the kind's default layout). */
  size?: PanelLayout
}

/**
 * Add a new instance of `kind` as a tab, a column or a split, and show it. An
 * unknown slot target falls back to a new column; a column beyond the limit
 * becomes a new slot in the last column.
 */
export function addInstance<T extends LayoutTree>(
  tree: T,
  kind: PanelKind,
  placement: InstancePlacement,
  opts: AddInstanceOptions = {}
): { layout: T; instanceId: string } {
  const settings = parseInstanceSettings(kind, opts.settings)
  const id =
    opts.id && !(opts.id in tree.instances) ? opts.id : newInstanceId(tree, kind, settings, opts)
  const layout = edit(tree, (d) => {
    const inst: PanelInstance = { id, kind, settings }
    const name = opts.name?.trim()
    if (name) inst.name = name
    d.instances[id] = inst
    placeTab(
      d,
      { instanceId: id },
      opts.size ?? instanceDefaultLayout(kind, settings),
      placement,
      opts
    )
  })
  return { layout, instanceId: id }
}

function placeTab(
  d: LayoutTree,
  tab: LayoutTab,
  size: PanelLayout,
  placement: InstancePlacement,
  ctx: OpContext
): void {
  const max = MAX_LAYOUT_COLUMNS
  if (placement.type === 'tab' && insertIntoSlot(d, tab, placement.slotId, placement.index)) return
  if (
    placement.type === 'split' &&
    insertSplit(d, tab, placement.slotId, placement.zone, size, ctx, max)
  )
    return
  insertColumn(d, tab, size, ctx, placement.type === 'column' ? placement.index : undefined, max)
}

/** The instances a layout switch parked, in layout order. */
export function parkedInstances(tree: LayoutTree): PanelInstance[] {
  const out: PanelInstance[] = []
  for (const column of tree.columns)
    for (const slot of column.slots)
      for (const tab of slot.tabs) {
        const inst = tree.instances[tab.instanceId]
        if (tab.parked && inst) out.push(inst)
      }
  return out
}

/**
 * Bring a parked instance back: its tab leaves the parked group for `placement`
 * (default: a new column at the end) and shows there. Anything not parked is a
 * no-op apart from the rev bump.
 */
export function unparkInstance<T extends LayoutTree>(
  tree: T,
  instanceId: string,
  placement: InstancePlacement = { type: 'column' },
  ctx: OpContext = {}
): T {
  return edit(tree, (d) => {
    const loc = findTab(d, instanceId)
    const inst = d.instances[instanceId]
    if (!loc || !inst || !d.columns[loc.columnIndex].slots[loc.slotIndex].tabs[loc.tabIndex].parked)
      return
    takeTab(d, instanceId)
    placeTab(d, { instanceId }, instanceDefaultLayout(inst.kind, inst.settings), placement, ctx)
  })
}

/**
 * Append a new primary-or-not instance as a column without the drag limit — for
 * adapters mirroring the flat legacy strip (Classic may exceed 8 columns).
 * Mutates `draft`; callers own the clone.
 */
export function appendColumnDraft(
  draft: LayoutTree,
  inst: PanelInstance,
  size: PanelLayout,
  ctx: OpContext = {}
): void {
  draft.instances[inst.id] = inst
  const column = newColumn({ instanceId: inst.id }, size, ctx)
  if (!draft.columns.some((c) => c.id === inst.id)) column.id = inst.id
  if (!draft.columns.some((c) => c.slots.some((s) => s.id === inst.id)))
    column.slots[0].id = inst.id
  draft.columns.push(column)
}

/** Drop empty slots and columns (hidden ones stay). */
export function pruneLayout<T extends LayoutTree>(tree: T): T {
  return finish(structuredClone(tree))
}

/** Repair the tree (see `normalizeLayoutTree`). */
export function normalizeLayout<T extends LayoutTree>(tree: T): T {
  return finish(structuredClone(tree))
}

/** Normalize a draft the caller already cloned and bump its rev (for adapters batching several edits). */
export function finishDraft<T extends LayoutTree>(draft: T): T {
  return finish(draft)
}
