/**
 * Task panel layout model: columns of tab groups (docs/plans/panel-model.md §1).
 *
 * A task's panels are `PanelInstance`s laid out in `LayoutColumn`s, left to
 * right. Each column stacks `LayoutSlot`s (tab groups) top to bottom; each slot
 * holds `LayoutTab`s, one per instance. Every instance appears in exactly one tab.
 *
 * Hiding keeps position: a hidden slot or tab stays in the tree. A column whose
 * slots are all hidden takes no width.
 */
import type { PanelLayout, PanelSizeOverride } from '../types'

export const PANEL_KINDS = [
  'agent',
  'terminal',
  'browser',
  'web',
  'editor',
  'artifacts',
  'artifact',
  'git',
  'processes',
  'settings',
  'description',
  'subtasks',
  'details'
] as const
export type PanelKind = (typeof PANEL_KINDS)[number]

/**
 * Max columns a user op (split, add) may create; at the limit it stacks
 * vertically instead. Derived layouts (Classic from panel_config) may exceed it.
 */
export const MAX_LAYOUT_COLUMNS = 8

/** The built-in layout every task starts on (today's panel strip). */
export const CLASSIC_LAYOUT_ID = 'classic'

/** Built-in layout ids, in display order. Definitions live in builtins.ts. */
export const BUILTIN_LAYOUT_IDS = [
  CLASSIC_LAYOUT_ID,
  'focus',
  'pair',
  'review',
  'split-settings',
  'two-git',
  'two-agents',
  'debug'
] as const
export type BuiltinLayoutId = (typeof BUILTIN_LAYOUT_IDS)[number]

/**
 * The legacy panel id the FIRST instance of a kind keeps, so ownership,
 * `panel_sizes`, `data-panel-id`, shortcuts and e2e selectors keep working.
 * `web` has none here: its primary id is the web panel definition id (`web:*`,
 * carried in `settings.panelId`). Kinds without an entry always get `<kind>:<uuid8>`.
 */
export const PRIMARY_INSTANCE_IDS: Partial<Record<PanelKind, string>> = {
  agent: 'terminal',
  browser: 'browser',
  editor: 'editor',
  artifacts: 'artifacts',
  git: 'diff',
  processes: 'processes',
  settings: 'settings'
}

/** Per-kind settings, validated in settings.ts. Unknown keys are preserved. */
export type PanelInstanceSettings = Record<string, unknown>

export interface PanelInstance {
  id: string
  kind: PanelKind
  name?: string
  settings: PanelInstanceSettings
}

export interface LayoutTab {
  instanceId: string
  hidden?: boolean
}

export interface LayoutSlot {
  id: string
  name?: string
  hidden?: boolean
  /** Share of the column height among its visible slots (> 0). */
  weight: number
  /** The tab shown; one of `tabs[].instanceId`, or null only when `tabs` is empty. */
  activeInstanceId: string | null
  tabs: LayoutTab[]
}

export interface LayoutColumn {
  id: string
  /** Default layout (fallback ◀ panel_config.layout), as `effectiveLayout` builds it. */
  size: PanelLayout
  /** Per-task drag override (unit + value only), like one `panel_sizes` entry. */
  sizeOverride?: PanelSizeOverride
  slots: LayoutSlot[]
}

export interface TaskLayout {
  v: 1
  /** Bumped by every op; concurrent writers merge by it. */
  rev: number
  /** The LayoutDefinition this layout was applied from (`classic` by default). */
  layoutId: string
  columns: LayoutColumn[]
  instances: Record<string, PanelInstance>
}

/** The part TaskLayout and LayoutDefinition share; ops work on either. */
export interface LayoutTree {
  columns: LayoutColumn[]
  instances: Record<string, PanelInstance>
}

export interface LayoutDefinition {
  id: string
  name: string
  builtin: boolean
  enabled: boolean
  /** ⌥N shortcut, 1–9. */
  shortcutIndex?: number
  columns: LayoutColumn[]
  instances: Record<string, PanelInstance>
}

/** What a user changed on a built-in layout. Absent fields keep the built-in value. */
export interface BuiltinLayoutOverride {
  name?: string
  enabled?: boolean
  /** null = the user removed the built-in's shortcut. */
  shortcutIndex?: number | null
  columns?: LayoutColumn[]
  instances?: Record<string, PanelInstance>
}

/** Per-user setting `task_layouts`. */
export interface TaskLayoutsSetting {
  v: 1
  defaultLayoutId: string
  builtinOverrides: Record<string, BuiltinLayoutOverride>
  user: LayoutDefinition[]
  /** Display order of layout ids (built-in and user). */
  order: string[]
}

/** Where a dropped tab splits off relative to a slot. */
export type SplitZone = 'left' | 'right' | 'before' | 'after'

export type InstancePlacement =
  /** A new tab in an existing slot (at `index`, default end). */
  | { type: 'tab'; slotId: string; index?: number }
  /** A new column at `index` (default end). Beyond the column limit: a new slot in the last column. */
  | { type: 'column'; index?: number }
  /** Split off `slotId` like a drop on its edge. */
  | { type: 'split'; slotId: string; zone: SplitZone }

export type TabDropTarget =
  | { type: 'merge'; slotId: string; index?: number }
  | { type: 'split'; slotId: string; zone: SplitZone }

/** Legacy per-task columns (`tasks.panel_visibility`, `tasks.panel_sizes`). */
export interface LegacyPanelState {
  panelVisibility: Record<string, boolean>
  panelSizes: Record<string, PanelSizeOverride>
}
