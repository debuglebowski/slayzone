/**
 * Layout definitions and switching (docs/plans/panel-model.md step 10).
 *
 * A LayoutDefinition is a named layout tree the user picks from the Layout menu:
 * the built-ins (with the user's `builtinOverrides`) and the user's own, all in
 * the per-user `task_layouts` setting. Applying one to a task never destroys live
 * state: the task's instances are matched to the definition's by kind, in order,
 * so they keep their ids (and with them their terminal groups, browser tabs and
 * open files); leftovers with live state are parked as hidden tabs.
 *
 * Everything here is pure: the setting mutators return a new setting, the switch
 * returns a new layout.
 */
import type { PanelConfig } from '../types'
import { builtinLayoutDefinitions, layoutFromDefinition, type LayoutCapabilities } from './builtins'
import { finishDraft } from './ops'
import { normalizeLayoutTree } from './settings'
import {
  CLASSIC_LAYOUT_ID,
  type BuiltinLayoutOverride,
  type LayoutColumn,
  type LayoutDefinition,
  type LayoutSlot,
  type LayoutTree,
  type PanelInstance,
  type TaskLayout,
  type TaskLayoutsSetting
} from './types'

/**
 * Window event that opens the Manage layouts dialog, for UI that cannot import the
 * task domain (Settings → Panels).
 */
export const OPEN_MANAGE_LAYOUTS_EVENT = 'slayzone:open-manage-layouts'

/** How many layouts get a switch shortcut (⌃⌥1–9): the first nine enabled ones. */
export const LAYOUT_SHORTCUT_COUNT = 9

/** A definition as the Layout menu and Manage layouts show it. */
export interface ResolvedLayoutDefinition extends LayoutDefinition {
  /** A built-in the user changed the tree of ("· edited"; Reset brings it back). */
  edited: boolean
}

function randomId8(): string {
  return globalThis.crypto.randomUUID().slice(0, 8)
}

// ── Live state that never belongs to a definition ────────────────────────────

/** Settings keys that point at one task's live data, not at how a layout looks. */
export const LIVE_SETTING_KEYS = ['terminalGroupIds'] as const

function withoutLiveSettings(inst: PanelInstance): PanelInstance {
  const settings = { ...inst.settings }
  for (const key of LIVE_SETTING_KEYS) delete settings[key]
  return { ...inst, settings }
}

/**
 * The part of a task layout a definition keeps: no parked tabs, no per-task size
 * overrides, no live-data settings (a definition's agent panel claims no task's
 * terminal groups). Instance ids stay: they only seed the next switch's matching.
 */
export function definitionTreeOf(tree: LayoutTree): LayoutTree {
  const instances: Record<string, PanelInstance> = {}
  const columns: LayoutColumn[] = tree.columns.map((column) => {
    const { sizeOverride: _drop, ...rest } = column
    return {
      ...rest,
      slots: column.slots.map((slot) => {
        const tabs = slot.tabs.filter((t) => !t.parked).map((t) => ({ ...t }))
        for (const t of tabs) {
          const inst = tree.instances[t.instanceId]
          if (inst) instances[inst.id] = withoutLiveSettings(inst)
        }
        return { ...slot, tabs }
      })
    }
  })
  return normalizeLayoutTree(columns, instances)
}

// ── Dirty detection ──────────────────────────────────────────────────────────

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson)
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, sortedJson(o[k])])
    )
  }
  return value
}

/**
 * What a layout looks like, independent of ids and sizes: per column, per slot,
 * its name, whether it is hidden and its tabs (kind, name, hidden, settings minus
 * live data). Parked tabs, column size overrides, slot weights and which tab is
 * active do not count.
 */
export function layoutShapeKey(tree: LayoutTree): string {
  const columns = tree.columns
    .map((column) =>
      column.slots
        .map((slot) => ({
          name: slot.name ?? null,
          hidden: slot.hidden === true,
          tabs: slot.tabs
            .filter((t) => !t.parked && tree.instances[t.instanceId])
            .map((t) => {
              const inst = withoutLiveSettings(tree.instances[t.instanceId])
              return [inst.kind, inst.name ?? null, t.hidden === true, sortedJson(inst.settings)]
            })
        }))
        .filter((slot) => slot.tabs.length > 0)
    )
    .filter((slots) => slots.length > 0)
  return JSON.stringify(columns)
}

/**
 * The task's layout differs from its definition in structure, visibility or
 * instance settings ("Unsaved changes"). Dragged sizes never count. A layout whose
 * definition is gone (deleted, or unknown here) counts as changed.
 */
export function isLayoutDirty(layout: LayoutTree, def: LayoutTree | null | undefined): boolean {
  if (!def) return true
  return layoutShapeKey(layout) !== layoutShapeKey(def)
}

// ── Switching ────────────────────────────────────────────────────────────────

/** What an instance is for matching: its kind, for a web panel which page, for an Artifact panel which file. */
function matchKey(inst: PanelInstance): string {
  if (inst.kind === 'artifact') {
    const id = typeof inst.settings.artifactId === 'string' ? inst.settings.artifactId : ''
    return `artifact|${id}`
  }
  if (inst.kind !== 'web') return inst.kind
  const panelId = typeof inst.settings.panelId === 'string' ? inst.settings.panelId : ''
  const url = typeof inst.settings.url === 'string' ? inst.settings.url : ''
  return `web|${panelId}|${url}`
}

/** Instances in layout order (columns, slots, tabs); parked ones after the rest. */
function orderedInstances(tree: LayoutTree): PanelInstance[] {
  const shown: PanelInstance[] = []
  const parked: PanelInstance[] = []
  for (const column of tree.columns)
    for (const slot of column.slots)
      for (const tab of slot.tabs) {
        const inst = tree.instances[tab.instanceId]
        if (inst) (tab.parked ? parked : shown).push(inst)
      }
  return [...shown, ...parked]
}

export interface SwitchLayoutOptions {
  /** The instance holds live state (sessions, tabs, files): park it rather than drop it. */
  hasLiveState: (inst: PanelInstance) => boolean
  newId?: () => string
}

export interface SwitchLayoutResult {
  layout: TaskLayout
  /** Instances the new layout had no place for, kept as parked tabs. */
  parked: string[]
  /** Instances dropped (no place, no live state): the caller releases their state. */
  dropped: PanelInstance[]
  /** Instances the definition brought that matched none of the task's. */
  added: string[]
}

/** The id of the group parked instances wait in (hidden, in the last column). */
export const PARKED_SLOT_ID = 'slot:parked'

/**
 * Park instances `ids` (their tabs are not in `columns`): hidden, parked tabs in the
 * one hidden parked group, made in the last column when the layout has none.
 * Mutates `columns`.
 */
export function appendParkedTabs(columns: LayoutColumn[], ids: readonly string[]): void {
  if (ids.length === 0) return
  const tabs = ids.map((instanceId) => ({ instanceId, hidden: true, parked: true }))
  const existing = columns.flatMap((c) => c.slots).find((s) => s.id === PARKED_SLOT_ID)
  if (existing) {
    existing.tabs.push(...tabs)
    existing.activeInstanceId ??= ids[0]
    return
  }
  const slot: LayoutSlot = {
    id: PARKED_SLOT_ID,
    hidden: true,
    weight: 1,
    activeInstanceId: ids[0],
    tabs
  }
  const last = columns.at(-1)
  if (last) last.slots.push(slot)
  else columns.push({ id: 'column:parked', size: { unit: 'fr', value: 1 }, slots: [slot] })
}

/**
 * Apply definition `def` to the task's `current` layout. Instances are matched by
 * kind (web panels by page) in order — an instance with the same id first, then
 * the rest in layout order — and keep their ids, names coming from the definition.
 * Unmatched current instances with live state are parked as hidden tabs in one
 * hidden group; the rest are dropped. Sizes come from the definition (no
 * overrides). Bumps `rev`.
 */
export function switchLayout(
  current: TaskLayout,
  def: LayoutDefinition,
  opts: SwitchLayoutOptions
): SwitchLayoutResult {
  const gen = opts.newId ?? randomId8
  const target = definitionTreeOf(def)
  const defOrder = orderedInstances(target)
  const curOrder = orderedInstances(current)

  // defId → current id
  const mapping = new Map<string, string>()
  const used = new Set<string>()
  for (const d of defOrder) {
    const cur = current.instances[d.id]
    if (cur && matchKey(cur) === matchKey(d)) {
      mapping.set(d.id, cur.id)
      used.add(cur.id)
    }
  }
  for (const d of defOrder) {
    if (mapping.has(d.id)) continue
    const cur = curOrder.find((c) => !used.has(c.id) && matchKey(c) === matchKey(d))
    if (!cur) continue
    mapping.set(d.id, cur.id)
    used.add(cur.id)
  }

  // Unmatched definition instances keep their id unless the task holds it already.
  const taken = new Set<string>([...Object.keys(current.instances), ...mapping.values()])
  const added: string[] = []
  for (const d of defOrder) {
    if (mapping.has(d.id)) continue
    let id = d.id
    while (taken.has(id)) id = `${d.kind}:${gen()}`
    taken.add(id)
    mapping.set(d.id, id)
    added.push(id)
  }

  const instances: Record<string, PanelInstance> = {}
  for (const d of defOrder) {
    const id = mapping.get(d.id) as string
    const cur = current.instances[id]
    const settings = { ...d.settings }
    if (cur)
      for (const key of LIVE_SETTING_KEYS)
        if (key in cur.settings) settings[key] = cur.settings[key]
    const inst: PanelInstance = { id, kind: d.kind, settings }
    if (d.name) inst.name = d.name
    instances[id] = inst
  }

  // Ids of columns and slots named after a definition instance follow its new id
  // (a Classic column is called after its panel, which renders it bare).
  const renameId = (id: string): string => mapping.get(id) ?? id
  const columns: LayoutColumn[] = target.columns.map((column) => ({
    ...column,
    id: renameId(column.id),
    slots: column.slots.map(
      (slot): LayoutSlot => ({
        ...slot,
        id: renameId(slot.id),
        activeInstanceId: slot.activeInstanceId ? renameId(slot.activeInstanceId) : null,
        tabs: slot.tabs.map((t) => ({ ...t, instanceId: renameId(t.instanceId) }))
      })
    )
  }))

  const parked: string[] = []
  const dropped: PanelInstance[] = []
  for (const cur of curOrder) {
    if (used.has(cur.id)) continue
    if (opts.hasLiveState(cur)) {
      parked.push(cur.id)
      instances[cur.id] = cur
    } else dropped.push(cur)
  }
  appendParkedTabs(columns, parked)

  const layout = finishDraft<TaskLayout>({
    v: 1,
    rev: current.rev,
    layoutId: def.id,
    columns,
    instances
  })
  return { layout, parked, dropped, added }
}

// ── The task_layouts setting ─────────────────────────────────────────────────

function applyOverride(
  def: LayoutDefinition,
  ov: BuiltinLayoutOverride | undefined
): ResolvedLayoutDefinition {
  if (!ov) return { ...def, edited: false }
  const out: ResolvedLayoutDefinition = { ...def, edited: false }
  if (ov.name) out.name = ov.name
  if (ov.enabled !== undefined) out.enabled = ov.enabled
  if (ov.columns && ov.instances) {
    out.columns = ov.columns
    out.instances = ov.instances
    out.edited = true
  }
  return out
}

/**
 * Every layout the user can pick, in display order (`order` first, then built-ins
 * in their order, then the user's): available built-ins with the user's overrides,
 * then the user's own. Disabled ones included (`enabled: false`).
 */
export function resolveLayoutDefinitions(
  setting: TaskLayoutsSetting,
  config: PanelConfig,
  caps: LayoutCapabilities
): ResolvedLayoutDefinition[] {
  const builtins = builtinLayoutDefinitions(config, caps)
    .filter((b) => b.available)
    .map(({ available: _a, ...def }) => applyOverride(def, setting.builtinOverrides[def.id]))
  const all: ResolvedLayoutDefinition[] = [
    ...builtins,
    ...setting.user.map((u) => ({ ...u, builtin: false, edited: false }))
  ]
  const rank = new Map(setting.order.map((id, i) => [id, i]))
  return all
    .map((def, i) => ({ def, key: rank.get(def.id) ?? setting.order.length + i }))
    .sort((a, b) => a.key - b.key)
    .map((e) => e.def)
}

/** The user edited the Classic definition: it no longer follows Settings → Panels. */
export function isClassicCustomized(setting: TaskLayoutsSetting): boolean {
  return !!setting.builtinOverrides.classic?.columns
}

/** The layout ⌃⌥`n` (1–9) switches to: the n-th enabled one, in display order. */
export function layoutAtShortcut(
  defs: readonly ResolvedLayoutDefinition[],
  n: number
): ResolvedLayoutDefinition | null {
  if (!Number.isInteger(n) || n < 1 || n > LAYOUT_SHORTCUT_COUNT) return null
  return defs.filter((d) => d.enabled)[n - 1] ?? null
}

/** The shortcut position (1–9) of layout `id`, or null (disabled, or past the ninth). */
export function shortcutPositionOf(
  defs: readonly ResolvedLayoutDefinition[],
  id: string
): number | null {
  const i = defs.filter((d) => d.enabled).findIndex((d) => d.id === id)
  return i >= 0 && i < LAYOUT_SHORTCUT_COUNT ? i + 1 : null
}

/**
 * The layout a new task starts from: the default definition's tree, or null for
 * Classic as it ships (a task without a stored layout derives it, and keeps
 * following `panel_config`).
 */
export function newTaskLayout(
  setting: TaskLayoutsSetting,
  config: PanelConfig,
  caps: LayoutCapabilities
): TaskLayout | null {
  const defs = resolveLayoutDefinitions(setting, config, caps)
  const def = defs.find((d) => d.id === setting.defaultLayoutId)
  if (!def || (def.id === CLASSIC_LAYOUT_ID && !def.edited)) return null
  return layoutFromDefinition({ ...def, ...definitionTreeOf(def) })
}

function withOrder(setting: TaskLayoutsSetting, defs: readonly { id: string }[]): string[] {
  return setting.order.length > 0 ? [...setting.order] : defs.map((d) => d.id)
}

function isBuiltin(setting: TaskLayoutsSetting, id: string): boolean {
  return !setting.user.some((u) => u.id === id)
}

/** Save `tree` as layout `id`'s tree (a built-in keeps it as its override). */
export function saveLayoutTree(
  setting: TaskLayoutsSetting,
  id: string,
  tree: LayoutTree
): TaskLayoutsSetting {
  const clean = definitionTreeOf(tree)
  if (!isBuiltin(setting, id))
    return {
      ...setting,
      user: setting.user.map((u) => (u.id === id ? { ...u, ...clean } : u))
    }
  return {
    ...setting,
    builtinOverrides: {
      ...setting.builtinOverrides,
      [id]: { ...setting.builtinOverrides[id], ...clean }
    }
  }
}

/** A fresh id for a user layout. */
export function newLayoutId(setting: TaskLayoutsSetting, gen: () => string = randomId8): string {
  for (;;) {
    const id = `layout:${gen()}`
    if (!setting.user.some((u) => u.id === id)) return id
  }
}

/**
 * Add a user layout named `name` with `tree`, right after `afterId` in the order
 * (default: at the end). Returns the new setting and the layout's id.
 */
export function addUserLayout(
  setting: TaskLayoutsSetting,
  defs: readonly { id: string }[],
  name: string,
  tree: LayoutTree,
  opts: { afterId?: string; id?: string } = {}
): { setting: TaskLayoutsSetting; id: string } {
  const id = opts.id ?? newLayoutId(setting)
  const def: LayoutDefinition = {
    id,
    name: name.trim() || 'Untitled layout',
    builtin: false,
    enabled: true,
    ...definitionTreeOf(tree)
  }
  const order = withOrder(setting, defs).filter((x) => x !== id)
  const at = opts.afterId ? order.indexOf(opts.afterId) : -1
  if (at >= 0) order.splice(at + 1, 0, id)
  else order.push(id)
  return { setting: { ...setting, user: [...setting.user, def], order }, id }
}

/** Rename a layout (blank names are ignored). */
export function renameLayout(
  setting: TaskLayoutsSetting,
  id: string,
  name: string
): TaskLayoutsSetting {
  const trimmed = name.trim()
  if (!trimmed) return setting
  if (!isBuiltin(setting, id))
    return {
      ...setting,
      user: setting.user.map((u) => (u.id === id ? { ...u, name: trimmed } : u))
    }
  return {
    ...setting,
    builtinOverrides: {
      ...setting.builtinOverrides,
      [id]: { ...setting.builtinOverrides[id], name: trimmed }
    }
  }
}

/**
 * Enable or disable layouts. Null when it would leave no layout enabled (the menu
 * always offers one).
 */
export function setLayoutsEnabled(
  setting: TaskLayoutsSetting,
  defs: readonly ResolvedLayoutDefinition[],
  ids: readonly string[],
  enabled: boolean
): TaskLayoutsSetting | null {
  const targets = new Set(ids)
  if (!enabled && !defs.some((d) => d.enabled && !targets.has(d.id))) return null
  const builtinOverrides = { ...setting.builtinOverrides }
  const user = setting.user.map((u) => (targets.has(u.id) ? { ...u, enabled } : u))
  for (const id of targets) {
    if (!isBuiltin(setting, id)) continue
    if (!defs.some((d) => d.id === id)) continue
    builtinOverrides[id] = { ...builtinOverrides[id], enabled }
  }
  return { ...setting, builtinOverrides, user }
}

/** Delete user layouts (built-ins can only be disabled or reset). */
export function deleteLayouts(
  setting: TaskLayoutsSetting,
  ids: readonly string[]
): TaskLayoutsSetting {
  const gone = new Set(ids.filter((id) => !isBuiltin(setting, id)))
  if (gone.size === 0) return setting
  return {
    ...setting,
    user: setting.user.filter((u) => !gone.has(u.id)),
    order: setting.order.filter((id) => !gone.has(id)),
    defaultLayoutId: gone.has(setting.defaultLayoutId) ? CLASSIC_LAYOUT_ID : setting.defaultLayoutId
  }
}

/** Copy layouts as new user layouts ("<name> copy"), each right after its original. */
export function duplicateLayouts(
  setting: TaskLayoutsSetting,
  defs: readonly ResolvedLayoutDefinition[],
  ids: readonly string[],
  gen?: () => string
): { setting: TaskLayoutsSetting; ids: string[] } {
  let next = setting
  let order: { id: string }[] = [...defs]
  const out: string[] = []
  for (const id of ids) {
    const src = defs.find((d) => d.id === id)
    if (!src) continue
    const added = addUserLayout(next, order, `${src.name} copy`, src, {
      afterId: id,
      id: newLayoutId(next, gen)
    })
    next = added.setting
    order = next.order.map((x) => ({ id: x }))
    out.push(added.id)
  }
  return { setting: next, ids: out }
}

/** Reset built-ins to how they ship: tree and name (enabled stays as the user set it). */
export function resetBuiltinLayouts(
  setting: TaskLayoutsSetting,
  ids: readonly string[]
): TaskLayoutsSetting {
  const builtinOverrides = { ...setting.builtinOverrides }
  for (const id of ids) {
    const ov = builtinOverrides[id]
    if (!ov) continue
    const { columns: _c, instances: _i, name: _n, ...rest } = ov
    if (Object.keys(rest).length === 0) delete builtinOverrides[id]
    else builtinOverrides[id] = rest
  }
  return { ...setting, builtinOverrides }
}

/** Put the layouts in this display order (unknown ids dropped, missing ones after). */
export function reorderLayouts(
  setting: TaskLayoutsSetting,
  defs: readonly { id: string }[],
  orderedIds: readonly string[]
): TaskLayoutsSetting {
  const known = new Set(defs.map((d) => d.id))
  const order = orderedIds.filter((id, i) => known.has(id) && orderedIds.indexOf(id) === i)
  for (const d of defs) if (!order.includes(d.id)) order.push(d.id)
  return { ...setting, order }
}

/** The layout new tasks start from. */
export function setDefaultLayout(setting: TaskLayoutsSetting, id: string): TaskLayoutsSetting {
  return { ...setting, defaultLayoutId: id }
}
