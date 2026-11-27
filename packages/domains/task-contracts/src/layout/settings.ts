/**
 * Validation for the layout model: per-kind instance settings (zod, unknown keys
 * preserved) and robust parsers for layouts and the `task_layouts` setting as they
 * come off disk or the wire. Parsers never throw: bad fields are repaired or
 * dropped, and only input that cannot be a layout at all yields null/defaults.
 */
import { z } from 'zod'
import type { PanelDimension, PanelLayout, PanelSizeOverride, PanelSizes } from '../types'
import {
  BUILTIN_LAYOUT_IDS,
  CLASSIC_LAYOUT_ID,
  PANEL_KINDS,
  type BuiltinLayoutOverride,
  type LayoutColumn,
  type LayoutDefinition,
  type LayoutSlot,
  type LayoutTab,
  type LayoutTree,
  type PanelInstance,
  type PanelInstanceSettings,
  type PanelKind,
  type TaskLayout,
  type TaskLayoutsSetting
} from './types'

// ── Per-kind settings ────────────────────────────────────────────────────────

const optString = z.string().optional()
const optStringList = z.array(z.string()).optional()
const noSettings = z.looseObject({})

const agentSettings = z.looseObject({
  /** Agent provider/mode for this panel (step 12); absent = the task's mode. */
  provider: optString,
  /** Terminal groups this instance shows; absent on the primary = every unclaimed group. */
  terminalGroupIds: optStringList
})
const terminalSettings = z.looseObject({ terminalGroupIds: optStringList })
const webSettings = z.looseObject({
  /** Web panel definition id (`web:*` in panel_config.webPanels). */
  panelId: optString,
  /** Static URL for a "Web page" panel. */
  url: optString
})
const artifactSettings = z.looseObject({ artifactId: optString })

export const PANEL_KIND_SETTINGS_SCHEMAS = {
  agent: agentSettings,
  terminal: terminalSettings,
  browser: noSettings,
  web: webSettings,
  editor: noSettings,
  artifacts: noSettings,
  artifact: artifactSettings,
  git: noSettings,
  processes: noSettings,
  settings: noSettings,
  description: noSettings,
  subtasks: noSettings,
  details: noSettings
} satisfies Record<PanelKind, z.ZodType<Record<string, unknown>>>

export type AgentPanelSettings = z.infer<typeof agentSettings>
export type TerminalPanelSettings = z.infer<typeof terminalSettings>
export type WebPanelSettings = z.infer<typeof webSettings>
export type ArtifactPanelSettings = z.infer<typeof artifactSettings>

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function hasOwn(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key)
}

/** Settings for `kind`: known keys validated (invalid ones dropped), unknown keys kept. */
export function parseInstanceSettings(kind: PanelKind, raw: unknown): PanelInstanceSettings {
  if (!isRecord(raw)) return {}
  const schema = PANEL_KIND_SETTINGS_SCHEMAS[kind]
  const input: Record<string, unknown> = { ...raw }
  // Each pass drops the keys that failed; known keys are few, so this ends quickly.
  for (let pass = 0; pass < 8; pass++) {
    const result = schema.safeParse(input)
    if (result.success) return result.data
    for (const issue of result.error.issues) {
      const key = issue.path[0]
      if (typeof key === 'string') delete input[key]
    }
  }
  return {}
}

export function isPanelKind(v: unknown): v is PanelKind {
  return typeof v === 'string' && (PANEL_KINDS as readonly string[]).includes(v)
}

// ── Sizes ────────────────────────────────────────────────────────────────────

const UNITS = new Set(['px', 'fr', 'pct'])
type Unit = PanelSizeOverride['unit']

function isUnit(v: unknown): v is Unit {
  return typeof v === 'string' && UNITS.has(v)
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function parseDimension(raw: unknown): PanelDimension | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw, unit: 'px' } : undefined
  if (!isRecord(raw) || !isUnit(raw.unit)) return undefined
  const value = finiteNumber(raw.value)
  return value === undefined ? undefined : { value, unit: raw.unit }
}

/** A column's default layout, or undefined when unit/value are unusable. Legacy px-number bounds are coerced. */
export function parsePanelLayout(raw: unknown): PanelLayout | undefined {
  if (!isRecord(raw) || !isUnit(raw.unit)) return undefined
  const value = finiteNumber(raw.value)
  if (value === undefined) return undefined
  const out: PanelLayout = { unit: raw.unit, value }
  const min = parseDimension(raw.min)
  const max = parseDimension(raw.max)
  if (min) out.min = min
  if (max) out.max = max
  if (raw.align === 'left' || raw.align === 'right') out.align = raw.align
  return out
}

/** One size override (`{unit, value}`), or undefined when unusable. */
export function parseSizeOverride(raw: unknown): PanelSizeOverride | undefined {
  if (!isRecord(raw) || !isUnit(raw.unit)) return undefined
  const value = finiteNumber(raw.value)
  return value === undefined ? undefined : { unit: raw.unit, value }
}

/**
 * The `panel_sizes` column → overrides. Same rules as the task page's
 * `normalizeOverrides`, incl. the legacy `{kind:'fixed'|'flex'}` shapes.
 */
export function parsePanelSizes(raw: unknown): PanelSizes {
  if (!isRecord(raw)) return {}
  const out: PanelSizes = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!isRecord(v)) continue
    if (isUnit(v.unit)) out[k] = { unit: v.unit, value: Number(v.value) || 0 }
    else if (v.kind === 'fixed') out[k] = { unit: 'px', value: Number(v.px) || 0 }
    else if (v.kind === 'flex') out[k] = { unit: 'fr', value: Number(v.weight) || 1 }
  }
  return out
}

// ── Tree ─────────────────────────────────────────────────────────────────────

const FALLBACK_COLUMN_SIZE: PanelLayout = { unit: 'fr', value: 1 }

function uniqueId(raw: unknown, fallback: string, taken: Set<string>): string {
  const base = typeof raw === 'string' && raw !== '' ? raw : fallback
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}~${n}`
  taken.add(id)
  return id
}

function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.trim()
  return name === '' ? undefined : name
}

function parseInstance(id: string, raw: unknown): PanelInstance | null {
  if (!isRecord(raw) || !isPanelKind(raw.kind)) return null
  const inst: PanelInstance = {
    id,
    kind: raw.kind,
    settings: parseInstanceSettings(raw.kind, raw.settings)
  }
  const name = cleanName(raw.name)
  if (name) inst.name = name
  return inst
}

/**
 * The tab a slot shows: the stored one while it is in the slot and visible (or
 * nothing is visible), else the first visible tab, else the first tab.
 */
export function pickActiveTab(tabs: readonly LayoutTab[], preferred: unknown): string | null {
  const current = tabs.find((t) => t.instanceId === preferred)
  const anyVisible = tabs.some((t) => !t.hidden)
  if (current && (!current.hidden || !anyVisible)) return current.instanceId
  return (tabs.find((t) => !t.hidden) ?? tabs[0])?.instanceId ?? null
}

/**
 * Repair a layout tree: every instance in exactly one tab (later duplicates and
 * dangling refs dropped, unreferenced instances dropped), unique column/slot ids,
 * positive weights, a valid active tab, no empty slots or columns. Hidden slots
 * and tabs stay where they are. Does not cap the column count.
 */
export function normalizeLayoutTree(rawColumns: unknown, rawInstances: unknown): LayoutTree {
  const instIn = isRecord(rawInstances) ? rawInstances : {}
  const instances: Record<string, PanelInstance> = {}
  const columnIds = new Set<string>()
  const slotIds = new Set<string>()
  const columns: LayoutColumn[] = []
  for (const rc of Array.isArray(rawColumns) ? rawColumns : []) {
    if (!isRecord(rc)) continue
    const slots: LayoutSlot[] = []
    for (const rs of Array.isArray(rc.slots) ? rc.slots : []) {
      if (!isRecord(rs)) continue
      const tabs: LayoutTab[] = []
      for (const rt of Array.isArray(rs.tabs) ? rs.tabs : []) {
        if (!isRecord(rt) || typeof rt.instanceId !== 'string') continue
        const id = rt.instanceId
        if (hasOwn(instances, id) || !hasOwn(instIn, id)) continue
        const inst = parseInstance(id, instIn[id])
        if (!inst) continue
        instances[id] = inst
        // Parked implies hidden: a parked tab is never shown in place.
        if (rt.parked === true) tabs.push({ instanceId: id, hidden: true, parked: true })
        else tabs.push(rt.hidden === true ? { instanceId: id, hidden: true } : { instanceId: id })
      }
      if (tabs.length === 0) continue
      const weight = finiteNumber(rs.weight)
      const slot: LayoutSlot = {
        id: uniqueId(rs.id, 'slot', slotIds),
        weight: weight !== undefined && weight > 0 ? weight : 1,
        activeInstanceId: pickActiveTab(tabs, rs.activeInstanceId),
        tabs
      }
      const name = cleanName(rs.name)
      if (name) slot.name = name
      if (rs.hidden === true) slot.hidden = true
      slots.push(slot)
    }
    if (slots.length === 0) continue
    const column: LayoutColumn = {
      id: uniqueId(rc.id, 'column', columnIds),
      size: parsePanelLayout(rc.size) ?? { ...FALLBACK_COLUMN_SIZE },
      slots
    }
    const sizeOverride = parseSizeOverride(rc.sizeOverride)
    if (sizeOverride) column.sizeOverride = sizeOverride
    columns.push(column)
  }
  return { columns, instances }
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * `tasks.panel_layout` (JSON string or parsed) → a normalized TaskLayout, or null
 * when it is not a v1 layout at all (the caller then derives from the legacy columns).
 */
export function parseTaskLayout(raw: unknown): TaskLayout | null {
  const o = parseJson(raw)
  if (!isRecord(o) || o.v !== 1 || !Array.isArray(o.columns)) return null
  const rev = typeof o.rev === 'number' && Number.isInteger(o.rev) && o.rev >= 0 ? o.rev : 0
  const layoutId =
    typeof o.layoutId === 'string' && o.layoutId !== '' ? o.layoutId : CLASSIC_LAYOUT_ID
  return { v: 1, rev, layoutId, ...normalizeLayoutTree(o.columns, o.instances) }
}

export function serializeTaskLayout(layout: TaskLayout): string {
  return JSON.stringify(layout)
}

function parseShortcutIndex(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 9 ? raw : undefined
}

/** A layout definition, or null without a usable id, name and columns. */
export function parseLayoutDefinition(raw: unknown): LayoutDefinition | null {
  const o = parseJson(raw)
  if (!isRecord(o) || typeof o.id !== 'string' || o.id === '' || !Array.isArray(o.columns))
    return null
  const name = cleanName(o.name)
  if (!name) return null
  const def: LayoutDefinition = {
    id: o.id,
    name,
    builtin: o.builtin === true,
    enabled: o.enabled !== false,
    ...normalizeLayoutTree(o.columns, o.instances)
  }
  const shortcutIndex = parseShortcutIndex(o.shortcutIndex)
  if (shortcutIndex !== undefined) def.shortcutIndex = shortcutIndex
  return def
}

// ── task_layouts setting ─────────────────────────────────────────────────────

export function defaultTaskLayoutsSetting(): TaskLayoutsSetting {
  return { v: 1, defaultLayoutId: CLASSIC_LAYOUT_ID, builtinOverrides: {}, user: [], order: [] }
}

const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_LAYOUT_IDS)

/**
 * The per-user `task_layouts` setting. User layouts with a broken shape, a
 * duplicate id or a built-in's id are dropped; a shortcut already taken (user
 * layouts first, then built-in overrides) is dropped; unknown ids leave `order`
 * and `defaultLayoutId` (which falls back to Classic).
 */
export function parseTaskLayoutsSetting(raw: unknown): TaskLayoutsSetting {
  const o = parseJson(raw)
  if (!isRecord(o) || o.v !== 1) return defaultTaskLayoutsSetting()
  const shortcuts = new Set<number>()
  const claimShortcut = (n: number | undefined): number | undefined => {
    if (n === undefined || shortcuts.has(n)) return undefined
    shortcuts.add(n)
    return n
  }

  const user: LayoutDefinition[] = []
  const userIds = new Set<string>()
  for (const ru of Array.isArray(o.user) ? o.user : []) {
    const def = parseLayoutDefinition(ru)
    if (!def || BUILTIN_IDS.has(def.id) || userIds.has(def.id)) continue
    userIds.add(def.id)
    def.builtin = false
    const shortcutIndex = claimShortcut(def.shortcutIndex)
    if (shortcutIndex === undefined) delete def.shortcutIndex
    user.push(def)
  }

  const builtinOverrides: Record<string, BuiltinLayoutOverride> = {}
  const rawOverrides = isRecord(o.builtinOverrides) ? o.builtinOverrides : {}
  for (const id of BUILTIN_LAYOUT_IDS) {
    const ro = hasOwn(rawOverrides, id) ? rawOverrides[id] : undefined
    if (!isRecord(ro)) continue
    const ov: BuiltinLayoutOverride = {}
    const name = cleanName(ro.name)
    if (name) ov.name = name
    if (typeof ro.enabled === 'boolean') ov.enabled = ro.enabled
    if (ro.shortcutIndex === null) ov.shortcutIndex = null
    else {
      const shortcutIndex = claimShortcut(parseShortcutIndex(ro.shortcutIndex))
      if (shortcutIndex !== undefined) ov.shortcutIndex = shortcutIndex
    }
    if (Array.isArray(ro.columns)) Object.assign(ov, normalizeLayoutTree(ro.columns, ro.instances))
    builtinOverrides[id] = ov
  }

  const known = (id: unknown): id is string =>
    typeof id === 'string' && (BUILTIN_IDS.has(id) || userIds.has(id))
  const order: string[] = []
  for (const id of Array.isArray(o.order) ? o.order : [])
    if (known(id) && !order.includes(id)) order.push(id)

  return {
    v: 1,
    defaultLayoutId: known(o.defaultLayoutId) ? o.defaultLayoutId : CLASSIC_LAYOUT_ID,
    builtinOverrides,
    user,
    order
  }
}
