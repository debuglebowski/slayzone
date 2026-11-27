/**
 * Task layout changes from outside the task view (docs/plans/panel-model.md step
 * 13): the `/api/tasks/:id/layout` and `/panels` REST routes behind `slay panels
 * layout …`.
 *
 * A change is one pure layout op (task-contracts) applied to the layout the task
 * view renders for this user (`currentTaskLayout`), written through `updateTaskOp`
 * so the hub dual-writes the legacy columns and every client gets the row with the
 * higher rev. Nothing live is lost: a layout switch or replacement parks instances
 * with live state, and closing a primary panel only hides it. A new agent/terminal
 * panel gets its first terminal group here (a `terminal_tabs` row), so it works
 * whether or not a task view is open. Removed panels' client-side state (browser
 * pages, terminal sessions) is released by the task view on `task:layout-changed`.
 */
import type { SlayzoneDb } from '@slayzone/platform'
import { SettingsService } from '@slayzone/settings-core/server'
import { createTabRow, tabsEvents } from '@slayzone/task-terminals/server'
import { getPtyDeps } from '@slayzone/terminal/hub'
import type { AgentId } from '@slayzone/terminal-contracts'
import {
  addInstance,
  AGENT_MAY_CHANGE_LAYOUT_SETTING_KEY,
  agentMayChangeLayout,
  checkPanelSettings,
  closeTab,
  currentTaskLayout,
  existingInstanceFor,
  FULL_LAYOUT_CAPABILITIES,
  hideTab,
  instanceHasLiveState,
  parsePanelConfig,
  parseTaskLayout,
  parseTaskLayoutsSetting,
  removedInstances,
  renameInstance,
  replaceTaskLayout,
  resolveLayoutDefinitions,
  resolvePlacement,
  showInstance,
  switchLayout,
  TASK_LAYOUTS_SETTING_KEY,
  terminalGroupIdsOf,
  updateInstanceSettings,
  type InstancePlacement,
  type PanelConfig,
  type PanelInstance,
  type PanelKind,
  type ResolvedLayoutDefinition,
  type Task,
  type TaskLayout,
  type TaskLayoutsSetting
} from '@slayzone/task-contracts'
import { taskEvents } from '../events.js'
import { getTaskOp } from './get.js'
import type { OpDeps } from './shared.js'
import { updateTaskOp } from './update.js'

/** The caller's settings a layout change reads (per user on a login hub). */
export interface TaskLayoutSettings {
  panelConfig: PanelConfig
  layouts: TaskLayoutsSetting
  /** `agent_may_change_layout` (default true). */
  agentMayChangeLayout: boolean
}

export async function readTaskLayoutSettings(
  db: SlayzoneDb,
  userId: string | null
): Promise<TaskLayoutSettings> {
  const settings = SettingsService.forDatabase(db).forUser(userId)
  const [panelConfig, layouts, gate] = await Promise.all([
    settings.get('panel_config'),
    settings.get(TASK_LAYOUTS_SETTING_KEY),
    settings.get(AGENT_MAY_CHANGE_LAYOUT_SETTING_KEY)
  ])
  return {
    panelConfig: parsePanelConfig(panelConfig),
    layouts: parseTaskLayoutsSetting(layouts ?? null),
    agentMayChangeLayout: agentMayChangeLayout(gate)
  }
}

/** A change the caller got wrong (400), aimed at nothing (404) or that conflicts (409). */
export class TaskLayoutChangeError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string
  ) {
    super(message)
    this.name = 'TaskLayoutChangeError'
  }
}

export type TaskLayoutChange =
  /** Switch to a layout definition, by id or (case-insensitive) name. */
  | { type: 'apply'; layoutId: string }
  /** Replace the whole layout (`layout show --json` edited). */
  | { type: 'replace'; layout: Record<string, unknown> }
  | {
      type: 'open'
      kind: PanelKind
      settings?: Record<string, unknown>
      placement?: InstancePlacement
      name?: string
    }
  | {
      type: 'update'
      instanceId: string
      hidden?: boolean
      name?: string | null
      settings?: Record<string, unknown>
    }
  | { type: 'close'; instanceId: string }

export interface TaskLayoutView {
  taskId: string
  layout: TaskLayout
  /** The layouts `apply` takes, in menu order. */
  definitions: Array<Pick<ResolvedLayoutDefinition, 'id' | 'name' | 'builtin' | 'enabled'>>
  /** False: agent sessions may not change this user's layouts. */
  agentMayChangeLayout: boolean
}

function definitionsOf(settings: TaskLayoutSettings): ResolvedLayoutDefinition[] {
  return resolveLayoutDefinitions(settings.layouts, settings.panelConfig, FULL_LAYOUT_CAPABILITIES)
}

/** GET: the layout the task view renders for this user, and the layouts it can switch to. */
export async function readTaskLayoutOp(
  db: SlayzoneDb,
  taskId: string,
  settings: TaskLayoutSettings
): Promise<TaskLayoutView | null> {
  const task = await getTaskOp(db, taskId)
  if (!task) return null
  return {
    taskId: task.id,
    layout: currentTaskLayout(task, settings.panelConfig, settings.layouts),
    definitions: definitionsOf(settings).map(({ id, name, builtin, enabled }) => ({
      id,
      name,
      builtin,
      enabled
    })),
    agentMayChangeLayout: settings.agentMayChangeLayout
  }
}

export interface TaskLayoutChangeResult {
  layout: TaskLayout
  /** The panel the change opened or changed (`open`, `update`, `close`). */
  instanceId?: string
  /** `open` showed the panel the task already had (one-per-task kinds, same artifact). */
  existing?: boolean
  /** Instances a switch or replacement parked (⋯ → Parked in the task view). */
  parked?: string[]
}

export interface TaskLayoutChangeDeps {
  opDeps: OpDeps
  /** `agent`: the request came from an agent session (the view offers Undo). */
  origin: 'agent' | 'user'
}

/** Enabled agent modes, or null when this host runs no agents (tests, a bare hub). */
async function enabledModes(): Promise<string[] | null> {
  try {
    return (await getPtyDeps().ops.agentsList()).filter((m) => m.enabled).map((m) => m.id)
  } catch {
    return null
  }
}

/** The agent mode a new agent/terminal panel starts in. */
async function panelMode(
  task: Task,
  kind: 'agent' | 'terminal',
  settings: Record<string, unknown>
): Promise<string> {
  if (kind === 'terminal') return 'terminal'
  const provider = settings.provider
  if (typeof provider !== 'string') return task.agent_id
  const modes = await enabledModes()
  if (modes && !modes.includes(provider))
    throw new TaskLayoutChangeError(
      400,
      `Unknown or disabled agent "${provider}". Enabled: ${modes.join(', ')}`
    )
  return provider
}

function panelNotFound(layout: TaskLayout, instanceId: string): TaskLayoutChangeError {
  const ids = Object.keys(layout.instances).join(', ')
  return new TaskLayoutChangeError(404, `Panel not found: ${instanceId}. Panels: ${ids}`)
}

/** Without null values (a patch's deletions, meaningless for a new panel). */
function withoutNulls(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null))
}

/**
 * Apply `change` to task `taskId` (a full id) and write it. Throws
 * `TaskLayoutChangeError` for a change that cannot apply; the task's row is then
 * untouched.
 */
export async function changeTaskLayoutOp(
  db: SlayzoneDb,
  taskId: string,
  change: TaskLayoutChange,
  settings: TaskLayoutSettings,
  deps: TaskLayoutChangeDeps
): Promise<TaskLayoutChangeResult> {
  const task = await getTaskOp(db, taskId)
  if (!task) throw new TaskLayoutChangeError(404, `Task not found: ${taskId}`)
  const current = currentTaskLayout(task, settings.panelConfig, settings.layouts)
  const hasLiveState = (inst: PanelInstance): boolean =>
    instanceHasLiveState(inst, {
      browserTabs: task.browser_tabs,
      editorOpenFiles: task.editor_open_files,
      instanceState: task.panel_instance_state
    })

  // Terminal groups made for new agent/terminal panels: announced once the layout
  // that claims them is written (else the primary agent panel shows them meanwhile).
  let madeGroups = false
  /** Give every agent/terminal instance in `ids` without a terminal group its first one. */
  const startTerminals = async (
    layout: TaskLayout,
    ids: readonly string[]
  ): Promise<TaskLayout> => {
    let next = layout
    for (const id of ids) {
      const inst = next.instances[id]
      if (!inst || (inst.kind !== 'agent' && inst.kind !== 'terminal')) continue
      if (terminalGroupIdsOf(inst).length > 0) continue
      const mode = await panelMode(task, inst.kind, inst.settings)
      const tab = await createTabRow(db, { taskId: task.id, mode: mode as AgentId })
      madeGroups = true
      next = updateInstanceSettings(next, id, { terminalGroupIds: [tab.groupId] })
    }
    return next
  }

  let next: TaskLayout
  const result: Omit<TaskLayoutChangeResult, 'layout'> = {}
  switch (change.type) {
    case 'apply': {
      const defs = definitionsOf(settings)
      const want = change.layoutId.trim().toLowerCase()
      const def =
        defs.find((d) => d.id === change.layoutId) ??
        defs.find((d) => d.name.toLowerCase() === want)
      if (!def)
        throw new TaskLayoutChangeError(
          400,
          `Unknown layout "${change.layoutId}". Layouts: ${defs.map((d) => d.id).join(', ')}`
        )
      const switched = switchLayout(current, def, { hasLiveState })
      next = await startTerminals(switched.layout, switched.added)
      result.parked = switched.parked
      break
    }
    case 'replace': {
      const parsed = parseTaskLayout({ ...change.layout, v: 1 })
      if (!parsed || parsed.columns.length === 0)
        throw new TaskLayoutChangeError(400, 'Invalid layout: it needs at least one column.')
      const replaced = replaceTaskLayout(current, parsed, hasLiveState)
      const added = Object.keys(replaced.layout.instances).filter((id) => !current.instances[id])
      next = await startTerminals(replaced.layout, added)
      result.parked = replaced.parked
      break
    }
    case 'open': {
      const check = checkPanelSettings(change.kind, withoutNulls(change.settings ?? {}))
      if (!check.ok) throw new TaskLayoutChangeError(400, check.error)
      const placement = resolvePlacement(current, change.placement ?? { type: 'column' })
      if (!placement)
        throw new TaskLayoutChangeError(
          400,
          `Unknown group or panel: ${(change.placement as { slotId: string }).slotId}`
        )
      const existing = existingInstanceFor(current, change.kind, check.settings)
      if (existing) {
        next = showInstance(current, existing)
        if (next === current) next = { ...current, rev: current.rev + 1 }
        result.instanceId = existing
        result.existing = true
        break
      }
      const added = addInstance(current, change.kind, placement, {
        settings: check.settings,
        name: change.name
      })
      next = await startTerminals(added.layout, [added.instanceId])
      result.instanceId = added.instanceId
      break
    }
    case 'update': {
      const inst = current.instances[change.instanceId]
      if (!inst) throw panelNotFound(current, change.instanceId)
      next = current
      if (change.settings !== undefined) {
        const check = checkPanelSettings(inst.kind, change.settings)
        if (!check.ok) throw new TaskLayoutChangeError(400, check.error)
        const patch: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(check.settings)) patch[k] = v === null ? undefined : v
        next = updateInstanceSettings(next, inst.id, patch)
      }
      if (change.name !== undefined) next = renameInstance(next, inst.id, change.name ?? undefined)
      if (change.hidden === true) next = hideTab(next, inst.id)
      if (change.hidden === false) next = showInstance(next, inst.id)
      if (next === current) next = { ...current, rev: current.rev + 1 }
      result.instanceId = inst.id
      break
    }
    case 'close': {
      if (!current.instances[change.instanceId]) throw panelNotFound(current, change.instanceId)
      next = closeTab(current, change.instanceId)
      result.instanceId = change.instanceId
      break
    }
  }

  const updated = await updateTaskOp(db, { id: task.id, panelLayout: next }, deps.opDeps)
  if (!updated) throw new TaskLayoutChangeError(404, `Task not found: ${taskId}`)
  if (madeGroups) tabsEvents.emit('tabs:changed', { taskId: task.id })
  const written = updated.panel_layout ?? next
  taskEvents.emit('task:layout-changed', {
    taskId: task.id,
    rev: written.rev,
    origin: deps.origin,
    before: current,
    removed: removedInstances(current, written)
  })
  return { layout: written, ...result }
}
