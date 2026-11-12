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
import { buildTaskProjectChangedEvents, buildTaskUpdatedEvents } from '../history.js'
import { taskEvents } from '../events.js'
import { resetConversation } from './task-conversations.js'
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
}

const placeholders = (n: number): string => Array(n).fill('?').join(', ')

async function planMove(
  db: SlayzoneDb,
  input: { taskIds: readonly string[]; targetProjectId: string; includeSubtasks: boolean }
): Promise<MovePlan> {
  const target = await db.get<{ id: string; name: string; columns_config: string | null }>(
    'SELECT id, name, columns_config FROM projects WHERE id = ?',
    [input.targetProjectId]
  )
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
    parentTitles: new Map()
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
    ? await db.all<{ id: string; name: string; columns_config: string | null }>(
        `SELECT id, name, columns_config FROM projects WHERE id IN (${placeholders(sourceIds.length)})`,
        sourceIds
      )
    : []

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
    parentTitles: new Map(parents.map((p) => [p.id, p.title]))
  }
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
  for (const m of plan.moves) {
    const id = m.before.id
    // The old project's folder is not this one: the task's computer forgets its paths.
    await notifyTaskPaths(id, { op: 'set', worktreePath: null, baseDir: null })
    // Every tab's agent ran in the old folder: the whole task resets — every tab,
    // every mode (a reset intent the hub delivers to the task's computers).
    if (options.resetSessions !== false) {
      try {
        await resetConversation(db, { taskId: id, scope: 'all-tabs' })
      } catch {
        /* best-effort: the move is committed */
      }
    }
    runtime.killPtysByTaskId(id)
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
      includeSubtasks: input.includeSubtasks ?? true
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
    worktreeCount: plan.moves.filter((m) => m.before.has_worktree).length
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
