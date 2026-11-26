/**
 * Built-in layout definitions. Classic is today's panel strip, computed from
 * `panel_config` (order, enabled panels, default sizes) until the user edits it.
 * The others need panel kinds or multi-instance support that later steps add;
 * each declares what it requires, and is unavailable until the app has it.
 */
import type { PanelConfig, PanelSizes } from '../types'
import { DEFAULT_TASK_PANEL_VISIBILITY, legacyPanelColumns } from './legacy'
import { instanceDefaultLayout, legacyIdOf } from './ops'
import {
  CLASSIC_LAYOUT_ID,
  type BuiltinLayoutId,
  type LayoutColumn,
  type LayoutDefinition,
  type LayoutTree,
  type PanelInstance,
  type PanelKind,
  type TaskLayout
} from './types'

/** What the running app can render. */
export interface LayoutCapabilities {
  kinds: readonly PanelKind[]
  /** More than one instance of a kind (plan step 7). */
  multiInstance: boolean
}

/** Today: the kinds behind the legacy panels, one instance each. */
export const LAYOUT_CAPABILITIES: LayoutCapabilities = {
  kinds: ['agent', 'browser', 'web', 'editor', 'artifacts', 'git', 'processes', 'settings'],
  multiInstance: false
}

export interface BuiltinLayoutSpec {
  id: BuiltinLayoutId
  name: string
  shortcutIndex?: number
  requires: { kinds: readonly PanelKind[]; multiInstance: boolean }
  build: (config: PanelConfig) => LayoutTree
}

/** `[instanceId, kind]` per tab, tabs per slot, slots per column; all visible. */
type TreeSpec = [string, PanelKind][][][]

function treeOf(spec: TreeSpec, config: PanelConfig): LayoutTree {
  const instances: Record<string, PanelInstance> = {}
  const columns: LayoutColumn[] = spec.map((slots) => {
    const [firstId, firstKind] = slots[0][0]
    return {
      id: firstId,
      size: instanceDefaultLayout(firstKind, {}, config),
      slots: slots.map((tabs) => {
        for (const [id, kind] of tabs) instances[id] = { id, kind, settings: {} }
        return {
          id: tabs[0][0],
          weight: 1,
          activeInstanceId: tabs[0][0],
          tabs: tabs.map(([instanceId]) => ({ instanceId }))
        }
      })
    }
  })
  return { columns, instances }
}

const AGENT: [string, PanelKind] = ['terminal', 'agent']

export const BUILTIN_LAYOUTS: readonly BuiltinLayoutSpec[] = [
  {
    id: CLASSIC_LAYOUT_ID,
    name: 'Classic',
    shortcutIndex: 1,
    requires: { kinds: ['agent'], multiInstance: false },
    // Every enabled panel in panel_config.order; agent + settings shown, like a fresh task.
    build: (config) =>
      legacyPanelColumns(config, DEFAULT_TASK_PANEL_VISIBILITY, {}, (enabled) => enabled)
  },
  {
    id: 'focus',
    name: 'Focus',
    shortcutIndex: 2,
    requires: { kinds: ['agent'], multiInstance: false },
    build: (config) => treeOf([[[AGENT]]], config)
  },
  {
    id: 'pair',
    name: 'Pair',
    shortcutIndex: 3,
    requires: { kinds: ['agent', 'browser'], multiInstance: false },
    build: (config) => treeOf([[[AGENT]], [[['browser', 'browser']]]], config)
  },
  {
    id: 'review',
    name: 'Review',
    shortcutIndex: 4,
    requires: { kinds: ['agent', 'git', 'editor'], multiInstance: false },
    build: (config) => treeOf([[[AGENT]], [[['diff', 'git']]], [[['editor', 'editor']]]], config)
  },
  {
    id: 'split-settings',
    name: 'Split settings',
    requires: { kinds: ['agent', 'description', 'subtasks', 'details'], multiInstance: false },
    build: (config) =>
      treeOf(
        [
          [[AGENT]],
          [[['description:00000001', 'description']], [['subtasks:00000001', 'subtasks']]],
          [[['details:00000001', 'details']]]
        ],
        config
      )
  },
  {
    id: 'two-git',
    name: 'Two Git',
    requires: { kinds: ['agent', 'git'], multiInstance: true },
    build: (config) => treeOf([[[AGENT]], [[['diff', 'git']]], [[['git:00000002', 'git']]]], config)
  },
  {
    id: 'two-agents',
    name: 'Two agents',
    requires: { kinds: ['agent'], multiInstance: true },
    build: (config) => treeOf([[[AGENT]], [[['agent:00000002', 'agent']]]], config)
  },
  {
    id: 'debug',
    name: 'Debug',
    requires: { kinds: ['agent', 'terminal', 'browser', 'processes'], multiInstance: false },
    build: (config) =>
      treeOf(
        [
          [[AGENT], [['terminal:00000001', 'terminal']]],
          [[['browser', 'browser']]],
          [[['processes', 'processes']]]
        ],
        config
      )
  }
]

export function isBuiltinLayoutAvailable(
  spec: BuiltinLayoutSpec,
  caps: LayoutCapabilities = LAYOUT_CAPABILITIES
): boolean {
  if (spec.requires.multiInstance && !caps.multiInstance) return false
  return spec.requires.kinds.every((k) => caps.kinds.includes(k))
}

function definitionOf(spec: BuiltinLayoutSpec, config: PanelConfig): LayoutDefinition {
  const def: LayoutDefinition = {
    id: spec.id,
    name: spec.name,
    builtin: true,
    enabled: true,
    ...spec.build(config)
  }
  if (spec.shortcutIndex !== undefined) def.shortcutIndex = spec.shortcutIndex
  return def
}

/** Classic: one column per enabled panel in `panel_config.order`, today's sizes and align. */
export function classicFromPanelConfig(config: PanelConfig): LayoutDefinition {
  return definitionOf(BUILTIN_LAYOUTS[0], config)
}

/** Every built-in definition (no user overrides applied), flagged by availability. */
export function builtinLayoutDefinitions(
  config: PanelConfig,
  caps: LayoutCapabilities = LAYOUT_CAPABILITIES
): (LayoutDefinition & { available: boolean })[] {
  return BUILTIN_LAYOUTS.map((spec) => ({
    ...definitionOf(spec, config),
    available: isBuiltinLayoutAvailable(spec, caps)
  }))
}

/** A fresh task layout applied from `def` (rev 0). */
export function layoutFromDefinition(def: LayoutDefinition): TaskLayout {
  return {
    v: 1,
    rev: 0,
    layoutId: def.id,
    columns: structuredClone(def.columns),
    instances: structuredClone(def.instances)
  }
}

/**
 * A layout still in Classic's shape: applied from Classic, and every column holds
 * one unnamed group with one shown tab of a primary instance, all three ids equal
 * to its legacy id. Only the hidden flags and size overrides differ from what
 * `panel_config` builds, so the strip keeps following `panel_config`.
 */
export function isClassicShaped(layout: TaskLayout): boolean {
  if (layout.layoutId !== CLASSIC_LAYOUT_ID) return false
  return layout.columns.every((column) => {
    if (column.slots.length !== 1) return false
    const [slot] = column.slots
    if (slot.id !== column.id || slot.name !== undefined || slot.tabs.length !== 1) return false
    const [tab] = slot.tabs
    const inst = layout.instances[tab.instanceId]
    return !tab.hidden && tab.instanceId === column.id && !!inst && legacyIdOf(inst) === column.id
  })
}

/**
 * Classic follows `panel_config` until the user edits it (docs/plans/panel-model.md
 * §1.3): a Classic-shaped layout is rebuilt from the config's order, enabled panels
 * and default sizes, keeping its hidden flags and size overrides (a panel the
 * layout lacks starts hidden; a disabled panel stays while shown, like today's
 * strip). Any other layout is returned as is. Keeps `rev`, so the result is a view,
 * not an edit.
 */
export function reconcileClassicLayout(layout: TaskLayout, config: PanelConfig): TaskLayout {
  if (!isClassicShaped(layout)) return layout
  const visibility: Record<string, boolean> = {}
  const sizes: PanelSizes = {}
  for (const column of layout.columns) {
    visibility[column.id] = !column.slots[0].hidden
    if (column.sizeOverride) sizes[column.id] = column.sizeOverride
  }
  const tree = legacyPanelColumns(
    config,
    visibility,
    sizes,
    (enabled, visible) => enabled || visible
  )
  return { ...layout, ...tree }
}
