import type { SlayzoneDb } from '@slayzone/platform'
import type { RecordActivityEventInput } from '@slayzone/history/server'
import type {
  MoveTasksToProjectInput,
  MoveTasksToProjectResult,
  MoveToProjectPreview,
  Task,
  UpdateTaskInput
} from '@slayzone/task-contracts'
import {
  getColumnById,
  getDefaultStatus,
  isKnownStatus,
  parseColumnsConfig
} from '@slayzone/projects-contracts'
import type { ColumnConfig } from '@slayzone/projects-contracts'
import { DEFAULT_AGENTS, sessionFollowsFolderChange } from '@slayzone/terminal-contracts'
import { buildTaskProjectChangedEvents, buildTaskUpdatedEvents } from '../history.js'
import { taskEvents } from '../events.js'
import { resetConversation } from './task-conversations.js'
import { moveSessionsToTaskComputer, taskMoveSessionsOrNull } from './task-move-sessions.js'
import {
  getRuntimeAdapters,
  notifyTaskPaths,
  parseTask,
  ProjectNotFoundError,
  validateTaskUpdate,
  type OpDeps
} from './shared.js'
// Loads the TxnRegistry augmentation that types this file's `db.namedTxn` calls.
import type {} from '../task-txns.js'

/**
 * Moving tasks to another project on this hub — the one path every project change
 * takes (`task.moveToProject`, and `task.update` / `task.updateMany` with a
 * `projectId`):
 *
 *   - the subtree comes along (any depth, archived included) unless left behind,
 *     in which case those subtasks are detached from the moved parent;
 *   - a moved task whose parent stays behind is detached from it;
 *   - each moved row's status re-homes to the target's default when the target
 *     lacks it; it loses its repo, worktree and base dir (they were the old
 *     project's folder); its tags follow by name;
 *   - all of it in ONE transaction (`task:move-project`), with one
 *     `task.project_changed` activity entry per moved row;
 *   - then, per moved row: its computer forgets its paths, its sessions reset
 *     (unless the caller keeps them) and its terminals stop.
 *
 * Rows already in the target are left as they are.
 */

interface PlanRow {
  before: Task
  /** Status in the target project. */
  status: string
  detach: boolean
}

interface MovePlan {
  targetProjectId: string
  targetName: string
  /** Project id → name, for every project a moved row leaves. */
  sourceNames: Map<string, string>
  /** Project id → its columns, for every project a moved row leaves. */
  sourceColumns: Map<string, ColumnConfig[] | null>
  targetColumns: ColumnConfig[] | null
  /** The selected rows that exist. */
  selected: Task[]
  /** Rows that change project. */
  moves: PlanRow[]
  /** Rows staying behind that lose their (moved) parent. */
  detached: Task[]
  /** Every subtask of the selection, any depth (whether or not it is brought). */
  subtaskCount: number
  /** Parent rows (id → title) of moved rows that are detached. */
  parentTitles: Map<string, string>
  /** The agent tabs of the moved rows, and whether each one's session can follow. */
  sessionTabs: SessionTab[]
}

/**
 * Agent modes whose session can follow its task to another COMPUTER: the chat and the
 * files beside it travel (`moveSessionsToTaskComputer`) — a Claude transcript or a
 * Codex rollout is a file the target computer can resume from. Codex in a terminal
 * is not here: it asks which folder to use when it resumes elsewhere.
 */
const SESSION_FOLLOWS_COMPUTER_MODES: readonly string[] = [
  'claude-code',
  'claude-chat',
  'codex-chat'
]

interface SessionTab {
  taskId: string
  taskTitle: string
  tabId: string
  tabLabel: string
  mode: string
  canKeep: boolean
  reason?: string
  /** Kept, the session copies to another computer of this hub. */
  crossComputer?: boolean
}

const placeholders = (n: number): string => Array(n).fill('?').join(', ')

async function planMove(
  db: SlayzoneDb,
  input: { taskIds: readonly string[]; targetProjectId: string; includeSubtasks: boolean }
): Promise<MovePlan> {
  const target = await db.get<{
    id: string
    name: string
    columns_config: string | null
    default_computer_id: string | null
  }>('SELECT id, name, columns_config, default_computer_id FROM projects WHERE id = ?', [
    input.targetProjectId
  ])
  if (!target) throw new ProjectNotFoundError(input.targetProjectId)
  const targetColumns = parseColumnsConfig(target.columns_config)

  const selectedIds = [...new Set(input.taskIds)]
  const selectedRows = await db.all<Record<string, unknown>>(
    `SELECT * FROM tasks WHERE id IN (${placeholders(selectedIds.length)})`,
    selectedIds
  )
  const selected = selectedRows.map((r) => parseTask(r)!)
  const empty: MovePlan = {
    targetProjectId: target.id,
    targetName: target.name,
    sourceNames: new Map(),
    sourceColumns: new Map(),
    targetColumns,
    selected,
    moves: [],
    detached: [],
    subtaskCount: 0,
    parentTitles: new Map(),
    sessionTabs: []
  }
  if (selected.length === 0) return empty

  // Every subtask of the selection, any depth — archived and deleted ones too, so
  // none is left pointing at a parent in another project.
  const ids = selected.map((t) => t.id)
  const subtreeRows = await db.all<Record<string, unknown>>(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM tasks WHERE id IN (${placeholders(ids.length)})
       UNION
       SELECT t.id FROM tasks t JOIN sub s ON t.parent_id = s.id
     )
     SELECT t.* FROM tasks t JOIN sub ON t.id = sub.id`,
    ids
  )
  const selectedSet = new Set(ids)
  const subtasks = subtreeRows.map((r) => parseTask(r)!).filter((t) => !selectedSet.has(t.id))
  const moveSet = input.includeSubtasks ? [...selected, ...subtasks] : selected
  const moveIds = new Set(moveSet.map((t) => t.id))

  const moves: PlanRow[] = moveSet
    .filter((t) => t.project_id !== target.id)
    .map((t) => ({
      before: t,
      status: isKnownStatus(t.status, targetColumns) ? t.status : getDefaultStatus(targetColumns),
      // The parent stays where it is: unless it is already in the target, detach.
      detach: t.parent_id !== null && !moveIds.has(t.parent_id)
    }))
  const movedIds = new Set(moves.map((m) => m.before.id))

  const detachParentIds = [
    ...new Set(moves.filter((m) => m.detach).map((m) => m.before.parent_id!))
  ]
  const parents = detachParentIds.length
    ? await db.all<{ id: string; title: string; project_id: string }>(
        `SELECT id, title, project_id FROM tasks WHERE id IN (${placeholders(detachParentIds.length)})`,
        detachParentIds
      )
    : []
  const parentById = new Map(parents.map((p) => [p.id, p]))
  for (const m of moves) {
    if (m.detach && parentById.get(m.before.parent_id!)?.project_id === target.id) m.detach = false
  }

  // Subtasks left behind (not brought) whose parent moves: detached.
  const detached = input.includeSubtasks
    ? []
    : subtasks.filter(
        (t) => t.parent_id !== null && movedIds.has(t.parent_id) && t.project_id !== target.id
      )

  const sourceIds = [...new Set(moves.map((m) => m.before.project_id))]
  const sources = sourceIds.length
    ? await db.all<{
        id: string
        name: string
        columns_config: string | null
        default_computer_id: string | null
      }>(
        `SELECT id, name, columns_config, default_computer_id FROM projects WHERE id IN (${placeholders(sourceIds.length)})`,
        sourceIds
      )
    : []
  const sourceById = new Map(sources.map((p) => [p.id, p]))

  const sessionTabs = await planSessionTabs(db, moves, {
    targetName: target.name,
    targetComputer: target.default_computer_id,
    sourceComputer: (projectId) => sourceById.get(projectId)?.default_computer_id ?? null
  })

  return {
    targetProjectId: target.id,
    targetName: target.name,
    sourceNames: new Map(sources.map((p) => [p.id, p.name])),
    sourceColumns: new Map(sources.map((p) => [p.id, parseColumnsConfig(p.columns_config)])),
    targetColumns,
    selected,
    moves,
    detached,
    subtaskCount: subtasks.length,
    parentTitles: new Map(parents.map((p) => [p.id, p.title])),
    sessionTabs
  }
}

/**
 * Each moved row's agent tabs (plain shells hold no agent session) and whether the
 * tab's session can follow the task: only when its agent resumes by id from another
 * folder (`sessionFollowsFolderChange`). A task whose work moves to another computer
 * (the target project's default) takes them along when this hub can copy sessions
 * between its computers and the agent resumes from a file that travels
 * (`SESSION_FOLLOWS_COMPUTER_MODES`).
 */
async function planSessionTabs(
  db: SlayzoneDb,
  moves: readonly PlanRow[],
  ctx: {
    targetName: string
    targetComputer: string | null
    sourceComputer: (projectId: string) => string | null
  }
): Promise<SessionTab[]> {
  if (moves.length === 0) return []
  const ids = moves.map((m) => m.before.id)
  const pins = await db.all<{ id: string; computer_id: string | null }>(
    `SELECT id, computer_id FROM tasks WHERE id IN (${placeholders(ids.length)})`,
    ids
  )
  const pinOf = new Map(pins.map((r) => [r.id, r.computer_id]))
  const tabs = await db.all<{
    id: string
    task_id: string
    label: string | null
    mode: string
    is_main: number
  }>(
    `SELECT id, task_id, label, mode, is_main FROM terminal_tabs
      WHERE task_id IN (${placeholders(ids.length)}) AND mode != 'terminal'
      ORDER BY task_id, is_main DESC, position`,
    ids
  )
  const byId = new Map(moves.map((m) => [m.before.id, m.before]))
  return tabs.map((tab) => {
    const task = byId.get(tab.task_id)!
    const pin = pinOf.get(tab.task_id) ?? null
    const before = pin ?? ctx.sourceComputer(task.project_id)
    const after = pin ?? ctx.targetComputer
    const agentLabel = DEFAULT_AGENTS.find((a) => a.id === tab.mode)?.label ?? tab.mode
    const follows = sessionFollowsFolderChange(tab.mode)
    const base = {
      taskId: task.id,
      taskTitle: task.title,
      tabId: tab.id,
      tabLabel: tab.label ?? (tab.is_main ? agentLabel : `${agentLabel} tab`),
      mode: tab.mode
    }
    if (before !== after) {
      if (!taskMoveSessionsOrNull() || !SESSION_FOLLOWS_COMPUTER_MODES.includes(tab.mode))
        return { ...base, canKeep: false, reason: `Runs on another computer in ${ctx.targetName}` }
      return { ...base, canKeep: true, crossComputer: true }
    }
    return follows.ok
      ? { ...base, canKeep: true }
      : { ...base, canKeep: false, reason: follows.reason }
  })
}

export interface MoveChange {
  id: string
  previous: Task
  next: Task
}

export interface MoveOutcome {
  changed: MoveChange[]
  movedTaskIds: string[]
  detachedTaskIds: string[]
  /** The move created tags in the target project (the board's tag list changed). */
  createdTags: boolean
}

export interface MoveOptions {
  taskIds: readonly string[]
  targetProjectId: string
  includeSubtasks?: boolean
  /** Default true. `false` keeps the sessions (a caller setting provider config). */
  resetSessions?: boolean
  /**
   * Agent tabs whose session follows the task to the new project (the move
   * dialog's choice). A tab whose session cannot follow (see `planSessionTabs`)
   * resets regardless. Empty / absent: the whole task resets.
   */
  keepSessionTabIds?: readonly string[]
}

/** The move itself: the transaction and every per-row consequence, no op events. */
export async function moveTasksToProject(
  db: SlayzoneDb,
  options: MoveOptions
): Promise<MoveOutcome> {
  const plan = await planMove(db, {
    taskIds: options.taskIds,
    targetProjectId: options.targetProjectId,
    includeSubtasks: options.includeSubtasks ?? true
  })
  if (plan.moves.length === 0 && plan.detached.length === 0)
    return { changed: [], movedTaskIds: [], detachedTaskIds: [], createdTags: false }

  const events: RecordActivityEventInput[] = []
  for (const m of plan.moves) {
    const after = {
      ...m.before,
      project_id: plan.targetProjectId,
      status: m.status,
      parent_id: m.detach ? null : m.before.parent_id
    }
    events.push(...buildTaskUpdatedEvents(m.before, after))
    events.push(
      ...buildTaskProjectChangedEvents(
        m.before,
        { id: plan.targetProjectId, name: plan.targetName },
        plan.sourceNames.get(m.before.project_id) ?? 'another project'
      )
    )
  }

  const { createdTagIds } = await db.namedTxn('task:move-project', {
    targetProjectId: plan.targetProjectId,
    moves: plan.moves.map((m) => ({ id: m.before.id, status: m.status, detach: m.detach })),
    detachIds: plan.detached.map((t) => t.id),
    events
  })

  const runtime = getRuntimeAdapters()
  const keepRequested = new Set(options.keepSessionTabIds ?? [])
  const kept = new Set(
    plan.sessionTabs.filter((t) => t.canKeep && keepRequested.has(t.tabId)).map((t) => t.tabId)
  )
  for (const m of plan.moves) {
    const id = m.before.id
    // Every agent of the task ran in the old folder: all stop — PTYs and chats. A
    // kept session resumes in the new folder when its agent starts again.
    runtime.killPtysByTaskId(id)
    await runtime.stopTaskAgents(id).catch((error: unknown) => {
      console.warn(`[task] agents of moved task ${id} not stopped:`, error)
    })
    // Its project runs on another computer and a session is kept: the sessions copy
    // there first (nothing writes to them now). A copy that fails resets them instead.
    const keptHere = new Set(kept)
    if (plan.sessionTabs.some((t) => t.taskId === id && t.crossComputer && kept.has(t.tabId))) {
      await moveSessionsToTaskComputer(db, id).catch((error: unknown) => {
        console.warn(`[task] sessions of moved task ${id} not moved to its computer:`, error)
        for (const t of plan.sessionTabs) if (t.taskId === id) keptHere.delete(t.tabId)
      })
    }
    // The old project's folder is not this one: the task's computer forgets its paths.
    await notifyTaskPaths(id, { op: 'set', worktreePath: null, baseDir: null })
    if (options.resetSessions !== false) {
      await resetMovedSessions(
        db,
        id,
        plan.sessionTabs.filter((t) => t.taskId === id),
        keptHere
      ).catch(() => {
        /* best-effort: the move is committed */
      })
    }
  }

  const touched = [...plan.moves.map((m) => m.before), ...plan.detached]
  const afterRows = await db.all<Record<string, unknown>>(
    `SELECT * FROM tasks WHERE id IN (${placeholders(touched.length)})`,
    touched.map((t) => t.id)
  )
  const afterById = new Map(afterRows.map((r) => [r.id as string, parseTask(r)!]))
  const changed = touched.flatMap((t) => {
    const next = afterById.get(t.id)
    return next ? [{ id: t.id, previous: t, next }] : []
  })
  return {
    changed,
    movedTaskIds: plan.moves.map((m) => m.before.id),
    detachedTaskIds: [
      ...plan.moves.filter((m) => m.detach).map((m) => m.before.id),
      ...plan.detached.map((t) => t.id)
    ],
    createdTags: createdTagIds.length > 0
  }
}

/**
 * The sessions a move resets (reset intents the hub delivers to the task's
 * computers). Nothing kept: the whole task — every tab, every mode. Otherwise each
 * agent tab not kept, on its own.
 */
async function resetMovedSessions(
  db: SlayzoneDb,
  taskId: string,
  tabs: readonly SessionTab[],
  kept: ReadonlySet<string>
): Promise<void> {
  if (!tabs.some((t) => kept.has(t.tabId))) {
    await resetConversation(db, { taskId, scope: 'all-tabs' })
    return
  }
  for (const tab of tabs) {
    if (!kept.has(tab.tabId)) await resetConversation(db, { taskId, scope: { tabId: tab.tabId } })
  }
}

/** The move plus what every task mutation tells its listeners. */
export async function moveTasksToProjectOp(
  db: SlayzoneDb,
  options: MoveOptions,
  deps: OpDeps
): Promise<MoveOutcome> {
  const outcome = await moveTasksToProject(db, options)
  for (const c of outcome.changed) {
    deps.ipcMain?.emit('db:tasks:update:done', null, c.id, {
      oldStatus: c.previous.status,
      previous: c.previous,
      next: c.next
    })
    taskEvents.emit('task:updated', {
      taskId: c.id,
      projectId: c.next.project_id,
      oldStatus: c.previous.status
    })
  }
  if (outcome.changed.length > 0) {
    // Created tags change every card's tag list: then a full reload, else just these rows.
    deps.onMutation?.(
      outcome.createdTags ? undefined : { taskIds: outcome.changed.map((c) => c.id) }
    )
  }
  return outcome
}

/** `task.moveToProject`. */
export async function moveTasksToProjectRequestOp(
  db: SlayzoneDb,
  input: MoveTasksToProjectInput,
  deps: OpDeps
): Promise<MoveTasksToProjectResult> {
  const { movedTaskIds, detachedTaskIds } = await moveTasksToProjectOp(
    db,
    {
      taskIds: input.taskIds,
      targetProjectId: input.targetProjectId,
      includeSubtasks: input.includeSubtasks ?? true,
      keepSessionTabIds: input.keepSessionTabIds ?? []
    },
    deps
  )
  return { movedTaskIds, detachedTaskIds }
}

/** `task.movePreview`: what the move would do, for the dialog. Writes nothing. */
export async function previewMoveToProjectOp(
  db: SlayzoneDb,
  input: MoveTasksToProjectInput
): Promise<MoveToProjectPreview> {
  const plan = await planMove(db, {
    taskIds: input.taskIds,
    targetProjectId: input.targetProjectId,
    includeSubtasks: input.includeSubtasks ?? true
  })
  const moveIds = plan.moves.map((m) => m.before.id)
  const tagRows = moveIds.length
    ? await db.all<{ name: string }>(
        `SELECT DISTINCT tg.name FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id
          WHERE tt.task_id IN (${placeholders(moveIds.length)}) AND tg.project_id != ?
            AND tg.name NOT IN (SELECT name FROM tags WHERE project_id = ?)
          ORDER BY tg.name`,
        [...moveIds, plan.targetProjectId, plan.targetProjectId]
      )
    : []
  const selectedIds = new Set(plan.selected.map((t) => t.id))
  return {
    taskCount: plan.moves.filter((m) => selectedIds.has(m.before.id)).length,
    subtaskCount: plan.subtaskCount,
    detachedFrom: plan.moves
      .filter((m) => m.detach && selectedIds.has(m.before.id))
      .map((m) => ({
        taskId: m.before.id,
        title: m.before.title,
        parentId: m.before.parent_id!,
        parentTitle: plan.parentTitles.get(m.before.parent_id!) ?? ''
      })),
    tagsToCreate: tagRows.map((r) => r.name),
    statusChanges: plan.moves
      .filter((m) => m.status !== m.before.status)
      .map((m) => ({
        taskId: m.before.id,
        title: m.before.title,
        from: m.before.status,
        to: m.status,
        fromLabel:
          getColumnById(m.before.status, plan.sourceColumns.get(m.before.project_id) ?? null)
            ?.label ?? m.before.status,
        toLabel: getColumnById(m.status, plan.targetColumns)?.label ?? m.status
      })),
    worktreeCount: plan.moves.filter((m) => m.before.has_worktree).length,
    sessions: plan.sessionTabs
  }
}

const LEGACY_FLAG_KEYS = [
  'claudeFlags',
  'codexFlags',
  'cursorFlags',
  'geminiFlags',
  'opencodeFlags'
] as const

/** Fields of an update besides its id. */
export function hasUpdateFields(data: Partial<UpdateTaskInput>): boolean {
  return Object.entries(data).some(([key, value]) => key !== 'id' && value !== undefined)
}

/**
 * A `task.update` / `task.updateMany` that changes the project: the move happens
 * first (one move for every listed task), then the rest of the update applies in
 * the new project. A status the target lacks is dropped from the rest (the move
 * re-homed it); one it has applies. An update that also sets provider config
 * keeps the sessions, as it always has.
 */
export async function applyProjectChange(
  db: SlayzoneDb,
  ids: readonly string[],
  updates: Omit<Partial<UpdateTaskInput>, 'id'>,
  deps: OpDeps
): Promise<{ rest: Omit<Partial<UpdateTaskInput>, 'id'>; moved: boolean }> {
  const targetProjectId = updates.projectId
  if (targetProjectId === undefined || ids.length === 0) return { rest: updates, moved: false }
  const rows = await db.all<{ id: string; project_id: string }>(
    `SELECT id, project_id FROM tasks WHERE id IN (${placeholders(ids.length)})`,
    [...ids]
  )
  const toMove = rows.filter((r) => r.project_id !== targetProjectId).map((r) => r.id)
  if (toMove.length === 0) return { rest: updates, moved: false }
  // The whole update is valid before anything is written.
  for (const id of ids) await validateTaskUpdate(db, { ...updates, id } as UpdateTaskInput)

  const keepsSessions =
    updates.providerConfig !== undefined || LEGACY_FLAG_KEYS.some((k) => updates[k] !== undefined)
  await moveTasksToProjectOp(
    db,
    { taskIds: toMove, targetProjectId, includeSubtasks: true, resetSessions: !keepsSessions },
    deps
  )
  const { projectId: _moved, ...rest } = updates
  if (rest.status !== undefined) {
    const target = await db.get<{ columns_config: string | null }>(
      'SELECT columns_config FROM projects WHERE id = ?',
      [targetProjectId]
    )
    if (!isKnownStatus(rest.status, parseColumnsConfig(target?.columns_config))) delete rest.status
  }
  return { rest, moved: true }
}
