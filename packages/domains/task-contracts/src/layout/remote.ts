/**
 * Layout changes from outside the task view (docs/plans/panel-model.md step 13):
 * the `/api/tasks/:id/layout` and `/panels` REST routes and `slay panels layout …`.
 *
 * Pure: the request schemas, the layout a task shows (what the task view renders),
 * which instances hold live state, placement resolution and wholesale replacement.
 * The hub reads the task and the caller's settings, applies one of these, and
 * writes the result through `updateTask({panelLayout})` (dual-write).
 */
import { z } from 'zod'
import type { BrowserTabsState } from '../browser-tabs'
import type { EditorOpenFilesState } from '../editor-open-files'
import type { PanelConfig, PanelInstanceState } from '../types'
import type { LayoutCapabilities } from './builtins'
import { reconcileClassicLayout } from './builtins'
import { appendParkedTabs, isClassicCustomized, LIVE_SETTING_KEYS } from './definitions'
import { browserTabsForInstance, terminalGroupIdsOf } from './instances'
import { normalizeWebPageUrl } from './kinds'
import { deriveLayoutFromLegacy, type LegacyTaskPanels } from './legacy'
import {
  finishDraft,
  findSlot,
  findTab,
  isPrimaryInstance,
  setSlotHidden,
  setTabHidden,
  unparkInstance
} from './ops'
import { PANEL_KIND_SETTINGS_SCHEMAS } from './settings'
import {
  PANEL_KINDS,
  type InstancePlacement,
  type LayoutTree,
  type PanelInstance,
  type PanelInstanceSettings,
  type PanelKind,
  type TaskLayout,
  type TaskLayoutsSetting
} from './types'

/** Per-user setting holding the layout definitions (`TaskLayoutsSetting`). */
export const TASK_LAYOUTS_SETTING_KEY = 'task_layouts'

/** Per-user setting: may an agent change a task's layout? `'0'` = no; absent = yes. */
export const AGENT_MAY_CHANGE_LAYOUT_SETTING_KEY = 'agent_may_change_layout'

export function agentMayChangeLayout(raw: string | null | undefined): boolean {
  return raw !== '0'
}

export { AGENT_CALLER, CALLER_HEADER, LAYOUT_LOCKED_CODE } from '../caller'

/** Every kind, several instances each: what the task view renders. */
export const FULL_LAYOUT_CAPABILITIES: LayoutCapabilities = {
  kinds: PANEL_KINDS,
  multiInstance: true
}

// ── The layout a task shows ─────────────────────────────────────────────────

export interface TaskLayoutSource extends LegacyTaskPanels {
  panel_layout?: TaskLayout | null
}

/**
 * The layout the task view renders for `task` and this user: the stored one, else
 * Classic derived from the legacy columns; a Classic-shaped layout follows
 * `panel_config` until the user customized Classic (like `useTaskLayout`).
 */
export function currentTaskLayout(
  task: TaskLayoutSource,
  config: PanelConfig,
  setting: TaskLayoutsSetting
): TaskLayout {
  const stored = task.panel_layout ?? deriveLayoutFromLegacy(task, config)
  return isClassicCustomized(setting) ? stored : reconcileClassicLayout(stored, config)
}

/** The stored state the live-state test reads (a task row's columns, or the page's copy). */
export interface InstanceLiveStateSource {
  browserTabs: BrowserTabsState | null | undefined
  editorOpenFiles: EditorOpenFilesState | null | undefined
  instanceState: PanelInstanceState | null | undefined
}

/**
 * Whether an instance holds live state a layout change must not throw away: the
 * primary agent (the task's main session), agent/terminal panels with terminal
 * groups, browser panels with a page open, editors with open files.
 */
export function instanceHasLiveState(inst: PanelInstance, src: InstanceLiveStateSource): boolean {
  const primary = isPrimaryInstance(inst)
  switch (inst.kind) {
    case 'agent':
      return primary || terminalGroupIdsOf(inst).length > 0
    case 'terminal':
      return terminalGroupIdsOf(inst).length > 0
    case 'browser':
      return src.browserTabs
        ? browserTabsForInstance(src.browserTabs, inst.id, primary).tabs.some(
            (t) => t.url !== '' && t.url !== 'about:blank'
          )
        : false
    case 'editor': {
      const saved = primary
        ? src.editorOpenFiles
        : (src.instanceState?.[inst.id]?.editorOpenFiles as EditorOpenFilesState | undefined)
      return (saved?.files.length ?? 0) > 0
    }
    default:
      return false
  }
}

/** Instances of `before` that `after` no longer has (their state is the caller's to release). */
export function removedInstances(before: LayoutTree, after: LayoutTree): PanelInstance[] {
  return Object.values(before.instances).filter((inst) => !(inst.id in after.instances))
}

// ── Request schemas ─────────────────────────────────────────────────────────

const splitZoneSchema = z.enum(['left', 'right', 'before', 'after'])

/**
 * Where a new panel goes. `slotId` names a group — or any panel instance, meaning
 * the group that holds it.
 */
export const instancePlacementSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('tab'),
    slotId: z.string().min(1),
    index: z.number().int().min(0).optional()
  }),
  z.strictObject({ type: z.literal('column'), index: z.number().int().min(0).optional() }),
  z.strictObject({ type: z.literal('split'), slotId: z.string().min(1), zone: splitZoneSchema })
])

const nameSchema = z.string().max(80)
const settingsSchema = z.record(z.string(), z.unknown())

/** POST /api/tasks/:id/panels */
export const openPanelInputSchema = z.strictObject({
  kind: z.enum(PANEL_KINDS),
  settings: settingsSchema.optional(),
  placement: instancePlacementSchema.optional(),
  name: nameSchema.optional()
})
export type OpenPanelInput = z.infer<typeof openPanelInputSchema>

/** PATCH /api/tasks/:id/panels/:instanceId — at least one field. */
export const updatePanelInputSchema = z
  .strictObject({
    hidden: z.boolean().optional(),
    /** null or blank = the kind's label. */
    name: nameSchema.nullable().optional(),
    /** Merged into the instance's settings; null deletes a key. */
    settings: settingsSchema.optional()
  })
  .refine((v) => v.hidden !== undefined || v.name !== undefined || v.settings !== undefined, {
    message: 'Nothing to change: give hidden, name or settings.'
  })
export type UpdatePanelInput = z.infer<typeof updatePanelInputSchema>

/** PUT /api/tasks/:id/layout — a layout definition (id or name), or a whole layout. */
export const applyLayoutInputSchema = z.union([
  z.strictObject({ layoutId: z.string().min(1) }),
  z.strictObject({ layout: z.record(z.string(), z.unknown()) })
])
export type ApplyLayoutInput = z.infer<typeof applyLayoutInputSchema>

/** The first issue of a failed parse, as one line for a 400. */
export function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid request.'
  const at = issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
  return `${at}${issue.message}`
}

export type SettingsCheck =
  | { ok: true; settings: PanelInstanceSettings }
  | { ok: false; error: string }

/**
 * Settings a caller gives for `kind`, checked strictly (a bad known key is an error,
 * not dropped as when parsing a stored layout). Live-data keys (`terminalGroupIds`)
 * belong to the hub, never to a caller. A web page's `url` is normalized like the
 * panel's own URL field; `null` values (deletions, for a patch) pass through.
 */
export function checkPanelSettings(kind: PanelKind, raw: Record<string, unknown>): SettingsCheck {
  for (const key of LIVE_SETTING_KEYS)
    if (key in raw) return { ok: false, error: `settings.${key} is managed by SlayZone.` }
  const values: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) if (v !== null) values[k] = v
  const parsed = PANEL_KIND_SETTINGS_SCHEMAS[kind].safeParse(values)
  if (!parsed.success) return { ok: false, error: `settings: ${describeZodError(parsed.error)}` }
  const settings: PanelInstanceSettings = { ...raw, ...parsed.data }
  if (kind === 'web' && typeof settings.url === 'string' && settings.url !== '') {
    const url = normalizeWebPageUrl(settings.url)
    if (!url) return { ok: false, error: `settings.url is not a usable URL: ${settings.url}` }
    settings.url = url
  }
  if (
    kind === 'web' &&
    typeof settings.panelId === 'string' &&
    !settings.panelId.startsWith('web:')
  )
    return { ok: false, error: 'settings.panelId must be a web panel id (web:…).' }
  return { ok: true, settings }
}

/**
 * A placement whose `slotId` may name a panel instance → one naming the group that
 * holds it. Null when the target is neither a group nor a panel of this layout.
 */
export function resolvePlacement(
  tree: LayoutTree,
  placement: InstancePlacement
): InstancePlacement | null {
  if (placement.type === 'column') return placement
  if (findSlot(tree, placement.slotId)) return placement
  const loc = findTab(tree, placement.slotId)
  if (!loc) return null
  return { ...placement, slotId: tree.columns[loc.columnIndex].slots[loc.slotIndex].id }
}

/**
 * Show instance `instanceId`: its group and its tab, made the active one. A parked
 * instance comes back as a new column (`unparkInstance`). Unknown ids: unchanged.
 */
export function showInstance<T extends LayoutTree>(tree: T, instanceId: string): T {
  const loc = findTab(tree, instanceId)
  if (!loc) return tree
  const slot = tree.columns[loc.columnIndex].slots[loc.slotIndex]
  if (slot.tabs[loc.tabIndex].parked) return unparkInstance(tree, instanceId)
  return setTabHidden(setSlotHidden(tree, slot.id, false), instanceId, false)
}

// ── Wholesale replacement ───────────────────────────────────────────────────

export interface ReplaceLayoutResult {
  layout: TaskLayout
  /** Current instances `next` lacked that hold live state, kept as parked tabs. */
  parked: string[]
  /** Current instances `next` lacked, without live state: the caller releases them. */
  dropped: PanelInstance[]
}

/**
 * Replace the task's layout with `next` (a parsed, normalized layout) without losing
 * live state: an instance `next` keeps (same id and kind) keeps its live-data
 * settings (terminal groups) unless `next` sets them; one `next` lacks is parked if
 * it holds live state, else dropped. Bumps `current`'s rev.
 */
export function replaceTaskLayout(
  current: TaskLayout,
  next: TaskLayout,
  hasLiveState: (inst: PanelInstance) => boolean
): ReplaceLayoutResult {
  const draft = structuredClone(next)
  for (const inst of Object.values(draft.instances)) {
    const cur = current.instances[inst.id]
    if (!cur || cur.kind !== inst.kind) continue
    for (const key of LIVE_SETTING_KEYS)
      if (key in cur.settings && !(key in inst.settings)) inst.settings[key] = cur.settings[key]
  }
  const parked: string[] = []
  const dropped: PanelInstance[] = []
  for (const cur of Object.values(current.instances)) {
    if (cur.id in draft.instances) continue
    if (hasLiveState(cur)) {
      parked.push(cur.id)
      draft.instances[cur.id] = structuredClone(cur)
    } else dropped.push(cur)
  }
  appendParkedTabs(draft.columns, parked)
  draft.rev = current.rev
  return { layout: finishDraft(draft), parked, dropped }
}

// ── The change event ────────────────────────────────────────────────────────

/**
 * `task.onLayoutChanged`: a layout change made outside the task view (REST, CLI).
 * The new layout itself arrives with the task row (`panel_layout`, higher rev);
 * this carries what the view needs to offer Undo and to release what was removed.
 */
export interface TaskLayoutChangedEvent {
  taskId: string
  /** The rev of the written layout. */
  rev: number
  /** `agent`: an agent session made it (the view offers Undo). */
  origin: 'agent' | 'user'
  /** The layout the change was applied to: what Undo restores. */
  before: TaskLayout
  /** Instances the change removed (their state is the view's to release). */
  removed: PanelInstance[]
}
