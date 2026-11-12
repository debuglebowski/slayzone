import { randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import type { RecordActivityEventInput } from '@slayzone/history/server'
import { getDefaultStatus, isKnownStatus, parseColumnsConfig } from '@slayzone/projects-contracts'
import {
  nextTaskMoveStep,
  TASK_MOVE_LOCKING_STATUSES,
  TASK_MOVE_STEPS,
  type BeginTaskMoveInput,
  type CrossHubMovePreview,
  type ImportTaskMoveInput,
  type TaskMoveBundle,
  type TaskRemoteBlocker,
  type TaskMove,
  type TaskMoveRedirects,
  type TaskMoveStatus,
  type TaskMoveStep
} from '@slayzone/task-contracts'
import { buildTaskProjectChangedEvents, buildTaskUpdatedEvents } from '../history.js'
import { artifactsDirOf, artifactTaskDir } from '../artifact-paths.js'
import { getRuntimeAdapters, parseTask } from './shared.js'
// Loads the TxnRegistry augmentation that types this file's `db.namedTxn` calls.
import type {} from '../task-txns.js'

/**
 * The source hub's side of moving tasks to another hub (slice 3a): the move's
 * journal, the lock it holds, the redirects it leaves. The app runs the steps
 * (`TASK_MOVE_STEPS`) and records each one here, so a paused or interrupted move
 * resumes from any device. Every operation is safe to repeat.
 */

/** A move operation the move's state does not allow (advance a paused move, …). */
export class TaskMoveStateError extends Error {
  override name = 'TaskMoveStateError'
}
/** No move with that id on this hub. */
export class TaskMoveNotFoundError extends Error {
  override name = 'TaskMoveNotFoundError'
  constructor(id: string) {
    super(`No task move ${id} on this hub`)
  }
}
/** A task the move names is already being moved by an unfinished move. */
export class TaskAlreadyMovingError extends Error {
  override name = 'TaskAlreadyMovingError'
}
/** The move cannot start: a task is missing, or linked to an integration. */
export class TaskMoveRefusedError extends Error {
  override name = 'TaskMoveRefusedError'
}

interface MoveRow {
  id: string
  direction: 'out' | 'in'
  peer_hub_id: string
  target_project_id: string
  root_task_ids: string
  include_subtasks: number
  include_sessions: number
  step: TaskMoveStep
  status: TaskMoveStatus
  error: string | null
  progress: string | null
  created_at: number
  updated_at: number
}

const placeholders = (n: number): string => Array(n).fill('?').join(', ')
const LOCKING_SQL = `(${TASK_MOVE_LOCKING_STATUSES.map((s) => `'${s}'`).join(', ')})`

async function toMove(db: SlayzoneDb, row: MoveRow): Promise<TaskMove> {
  const tasks = await db.all<{ task_id: string }>(
    'SELECT task_id FROM task_move_tasks WHERE move_id = ? ORDER BY rowid',
    [row.id]
  )
  return {
    id: row.id,
    direction: row.direction,
    peerHubId: row.peer_hub_id,
    targetProjectId: row.target_project_id,
    rootTaskIds: JSON.parse(row.root_task_ids) as string[],
    taskIds: tasks.map((t) => t.task_id),
    includeSubtasks: row.include_subtasks === 1,
    includeSessions: row.include_sessions === 1,
    step: row.step,
    status: row.status,
    error: row.error,
    progress: row.progress ? (JSON.parse(row.progress) as TaskMove['progress']) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function getTaskMove(db: SlayzoneDb, id: string): Promise<TaskMove> {
  const row = await db.get<MoveRow>('SELECT * FROM task_moves WHERE id = ?', [id])
  if (!row) throw new TaskMoveNotFoundError(id)
  return toMove(db, row)
}

export async function listTaskMoves(
  db: SlayzoneDb,
  opts: { statuses?: readonly TaskMoveStatus[] } = {}
): Promise<TaskMove[]> {
  const statuses = opts.statuses ?? []
  const rows = statuses.length
    ? await db.all<MoveRow>(
        `SELECT * FROM task_moves WHERE status IN (${placeholders(statuses.length)}) ORDER BY created_at`,
        [...statuses]
      )
    : await db.all<MoveRow>('SELECT * FROM task_moves ORDER BY created_at')
  return Promise.all(rows.map((r) => toMove(db, r)))
}

/**
 * Begin moving `taskIds` (and, unless left behind, their subtrees — archived and
 * deleted subtasks too) to `targetProjectId` on `targetHubId`: the journal row, the
 * lock on every task, and every agent of those tasks stopped. The move then waits at
 * its `export` step. Refused for a task linked to an integration (its connection
 * lives on this hub) or one already being moved.
 */
export async function beginTaskMove(
  db: SlayzoneDb,
  input: BeginTaskMoveInput,
  opts: { createdBy?: string | null } = {}
): Promise<TaskMove> {
  const id = input.id ?? randomUUID()
  const existing = await db.get<MoveRow>('SELECT * FROM task_moves WHERE id = ?', [id])
  if (existing) return toMove(db, existing)

  const rootIds = [...new Set(input.taskIds)]
  const roots = await db.all<{ id: string }>(
    `SELECT id FROM tasks WHERE id IN (${placeholders(rootIds.length)})`,
    rootIds
  )
  if (roots.length !== rootIds.length) {
    const found = new Set(roots.map((r) => r.id))
    throw new TaskMoveRefusedError(
      `Task not found: ${rootIds.filter((t) => !found.has(t)).join(', ')}`
    )
  }
  const includeSubtasks = input.includeSubtasks ?? true
  const taskIds = includeSubtasks
    ? (
        await db.all<{ id: string }>(
          `WITH RECURSIVE sub(id) AS (
             SELECT id FROM tasks WHERE id IN (${placeholders(rootIds.length)})
             UNION
             SELECT t.id FROM tasks t JOIN sub s ON t.parent_id = s.id
           )
           SELECT id FROM sub`,
          rootIds
        )
      ).map((r) => r.id)
    : rootIds

  const linked = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM external_links WHERE task_id IN (${placeholders(taskIds.length)})`,
    taskIds
  )
  if ((linked?.n ?? 0) > 0)
    throw new TaskMoveRefusedError(
      'A task is linked to an integration on this hub. Unlink it before moving it to another hub.'
    )

  const result = await db.namedTxn('task:begin-move', {
    id,
    peerHubId: input.targetHubId,
    targetProjectId: input.targetProjectId,
    rootTaskIds: rootIds,
    taskIds,
    includeSubtasks,
    includeSessions: input.includeSessions ?? true,
    createdBy: opts.createdBy ?? null,
    now: Date.now()
  })
  if (result.outcome === 'conflict')
    throw new TaskAlreadyMovingError(
      `Already being moved to another hub: ${result.taskIds.join(', ')}`
    )

  // The lock step: nothing of these tasks may keep running here while they move.
  const runtime = getRuntimeAdapters()
  for (const taskId of taskIds) {
    runtime.killPtysByTaskId(taskId)
    await runtime.stopTaskAgents(taskId).catch((error: unknown) => {
      console.warn(`[task] agents of moving task ${taskId} not stopped:`, error)
    })
  }
  return advanceTaskMove(db, { id, completed: 'lock' })
}

async function setMove(
  db: SlayzoneDb,
  id: string,
  sets: Record<string, unknown>,
  where: { status?: readonly TaskMoveStatus[]; step?: TaskMoveStep } = {}
): Promise<number> {
  const keys = Object.keys(sets)
  const clauses = ['id = ?']
  const params: unknown[] = [...Object.values(sets), Date.now(), id]
  if (where.status) {
    clauses.push(`status IN (${placeholders(where.status.length)})`)
    params.push(...where.status)
  }
  if (where.step) {
    clauses.push('step = ?')
    params.push(where.step)
  }
  const res = await db.run(
    `UPDATE task_moves SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ?
      WHERE ${clauses.join(' AND ')}`,
    params
  )
  return res.changes
}

/**
 * `completed` is done: the move goes on to the next step. Repeating a step already
 * passed changes nothing (a retried call); a step not reached yet, or a move not
 * running, is refused.
 */
export async function advanceTaskMove(
  db: SlayzoneDb,
  input: { id: string; completed: TaskMoveStep }
): Promise<TaskMove> {
  const move = await getTaskMove(db, input.id)
  const at = TASK_MOVE_STEPS.indexOf(move.step)
  const done = TASK_MOVE_STEPS.indexOf(input.completed)
  if (done < at) return move
  if (done > at)
    throw new TaskMoveStateError(`The move is at "${move.step}", not "${input.completed}"`)
  if (move.status !== 'running') throw new TaskMoveStateError(`The move is ${move.status}`)
  const next = nextTaskMoveStep(move.step)
  if (!next)
    throw new TaskMoveStateError(
      'The last step is finished by releasing the move (taskMoves.release)'
    )
  // Guarded on the step: when another device's call won the race, nothing is written
  // twice and the journal answers what it holds now.
  await setMove(
    db,
    move.id,
    { step: next, progress: null },
    { status: ['running'], step: move.step }
  )
  return getTaskMove(db, move.id)
}

/** How far the running step got (bytes copied, rows written). */
export async function reportTaskMoveProgress(
  db: SlayzoneDb,
  input: { id: string; step: TaskMoveStep; done: number; total: number }
): Promise<TaskMove> {
  await getTaskMove(db, input.id)
  await setMove(
    db,
    input.id,
    { progress: JSON.stringify({ step: input.step, done: input.done, total: input.total }) },
    { step: input.step }
  )
  return getTaskMove(db, input.id)
}

/** Pause after the step that is running: the move waits, its tasks stay locked. */
export async function pauseTaskMove(db: SlayzoneDb, id: string): Promise<TaskMove> {
  const move = await getTaskMove(db, id)
  if (move.status === 'paused') return move
  if (move.status !== 'running') throw new TaskMoveStateError(`The move is ${move.status}`)
  await setMove(db, id, { status: 'paused' }, { status: ['running'] })
  return getTaskMove(db, id)
}

/** Resume a paused or failed move from the step it stopped at. */
export async function resumeTaskMove(db: SlayzoneDb, id: string): Promise<TaskMove> {
  const move = await getTaskMove(db, id)
  if (move.status === 'running') return move
  if (move.status !== 'paused' && move.status !== 'failed')
    throw new TaskMoveStateError(`The move is ${move.status}`)
  await setMove(db, id, { status: 'running', error: null }, { status: ['paused', 'failed'] })
  return getTaskMove(db, id)
}

/** A step failed: the move stops there, its tasks locked, until resumed or canceled. */
export async function failTaskMove(
  db: SlayzoneDb,
  input: { id: string; error: string }
): Promise<TaskMove> {
  const move = await getTaskMove(db, input.id)
  if (move.status !== 'running' && move.status !== 'paused')
    throw new TaskMoveStateError(`The move is ${move.status}`)
  await setMove(
    db,
    input.id,
    { status: 'failed', error: input.error },
    {
      status: ['running', 'paused']
    }
  )
  return getTaskMove(db, input.id)
}

/**
 * Give up a move whose tasks the target has not taken yet (before `release`): the
 * lock is lifted and the tasks stay here. Whatever an `import` wrote on the target
 * is the app's to remove there (the target's own journal row says so).
 */
export async function cancelTaskMove(db: SlayzoneDb, id: string): Promise<TaskMove> {
  const move = await getTaskMove(db, id)
  if (move.status === 'canceled') return move
  if (move.status === 'done') throw new TaskMoveStateError('The move is done')
  if (TASK_MOVE_STEPS.indexOf(move.step) > TASK_MOVE_STEPS.indexOf('commit'))
    throw new TaskMoveStateError('The target hub took the tasks: the move can only finish now')
  await setMove(db, id, { status: 'canceled' }, { status: TASK_MOVE_LOCKING_STATUSES })
  return getTaskMove(db, id)
}

/**
 * The last step: the tasks are the target hub's now. Each leaves a redirect to that
 * hub and the lock is lifted. Released again: the same answer.
 */
export async function releaseTaskMove(
  db: SlayzoneDb,
  id: string,
  /** This hub's data root (its `artifacts/`); default: the runtime's. */
  dataRoot?: string
): Promise<TaskMove> {
  const move = await getTaskMove(db, id)
  if (move.status === 'done') return move
  if (move.step !== 'release' || move.status !== 'running')
    throw new TaskMoveStateError(
      `The move is ${move.status} at "${move.step}": it releases only when running at "release"`
    )
  await db.namedTxn('task:release-move', { id, now: Date.now() })
  // Their artifact files are the target's now (copied in `copy-files`).
  const runtime = getRuntimeAdapters()
  for (const taskId of move.taskIds) {
    await Promise.resolve()
      .then(() =>
        runtime.worktrees.removeArtifactDir(
          artifactTaskDir(artifactsDirOf(dataRoot ?? runtime.getDataRoot()), taskId)
        )
      )
      .catch((error: unknown) => {
        console.warn(`[task] artifact files of moved task ${taskId} not removed:`, error)
      })
  }
  return getTaskMove(db, id)
}

/** Where moved tasks went (task id → hub and move); a task not listed did not move away. */
export async function taskMoveRedirects(
  db: SlayzoneDb,
  taskIds: readonly string[]
): Promise<TaskMoveRedirects> {
  if (taskIds.length === 0) return {}
  const rows = await db.all<{ task_id: string; hub_id: string; move_id: string }>(
    `SELECT task_id, hub_id, move_id FROM task_move_redirects WHERE task_id IN (${placeholders(taskIds.length)})`,
    [...taskIds]
  )
  return Object.fromEntries(rows.map((r) => [r.task_id, { hubId: r.hub_id, moveId: r.move_id }]))
}

/** Whether any move holds a lock now — the write gate's cheap first question. */
export async function anyTaskMoveLocking(db: SlayzoneDb): Promise<boolean> {
  return !!(await db.get(`SELECT 1 FROM task_moves WHERE status IN ${LOCKING_SQL} LIMIT 1`))
}

/** Which of `taskIds` an unfinished move locks. */
export async function lockedTaskIds(db: SlayzoneDb, taskIds: readonly string[]): Promise<string[]> {
  if (taskIds.length === 0) return []
  const rows = await db.all<{ task_id: string }>(
    `SELECT DISTINCT mt.task_id FROM task_move_tasks mt JOIN task_moves m ON m.id = mt.move_id
      WHERE m.status IN ${LOCKING_SQL} AND mt.task_id IN (${placeholders(taskIds.length)})`,
    [...taskIds]
  )
  return rows.map((r) => r.task_id)
}

// ── the rows a move carries (slice 3b) ─────────────────────────────────────────

type Row = Record<string, unknown>

/**
 * The bundle of a move's tasks — every row `TASK_MOVE_TABLES` names — read on the
 * hub they leave. Safe to read again (a retried export); only while the move holds
 * its lock, so the rows cannot change underneath.
 */
export async function exportTaskMove(db: SlayzoneDb, id: string): Promise<TaskMoveBundle> {
  const move = await getTaskMove(db, id)
  if (move.direction !== 'out' || !TASK_MOVE_LOCKING_STATUSES.includes(move.status))
    throw new TaskMoveStateError(`The move is ${move.status}: nothing to export`)
  if (TASK_MOVE_STEPS.indexOf(move.step) < TASK_MOVE_STEPS.indexOf('export'))
    throw new TaskMoveStateError('The move has not locked its tasks yet')
  const ids = move.taskIds
  const ph = placeholders(ids.length)
  const all = (sql: string, params: unknown[] = ids): Promise<Row[]> => db.all<Row>(sql, params)
  const artifacts = await all(`SELECT * FROM task_artifacts WHERE task_id IN (${ph})`)
  const artifactIds = artifacts.map((a) => a.id as string)
  const dependencies = await all(
    `SELECT task_id, blocks_task_id FROM task_dependencies
      WHERE task_id IN (${ph}) OR blocks_task_id IN (${ph})`,
    [...ids, ...ids]
  )
  const inside = new Set(ids)
  const both = (d: Row): boolean =>
    inside.has(d.task_id as string) && inside.has(d.blocks_task_id as string)
  return {
    moveId: move.id,
    rootTaskIds: move.rootTaskIds,
    rows: {
      tasks: await all(`SELECT * FROM tasks WHERE id IN (${ph})`),
      terminal_tabs: await all(`SELECT * FROM terminal_tabs WHERE task_id IN (${ph})`),
      task_tags: await all(`SELECT * FROM task_tags WHERE task_id IN (${ph})`),
      task_dependencies: dependencies.filter(both),
      artifact_folders: await all(`SELECT * FROM artifact_folders WHERE task_id IN (${ph})`),
      task_artifacts: artifacts,
      artifact_versions: artifactIds.length
        ? await all(
            `SELECT * FROM artifact_versions WHERE artifact_id IN (${placeholders(artifactIds.length)})`,
            artifactIds
          )
        : [],
      activity_events: await all(`SELECT * FROM activity_events WHERE task_id IN (${ph})`),
      usage_records: await all(`SELECT * FROM usage_records WHERE task_id IN (${ph})`)
    },
    tags: await db.all<TaskMoveBundle['tags'][number]>(
      `SELECT DISTINCT tg.id, tg.name, tg.color, tg.text_color
         FROM tags tg JOIN task_tags tt ON tt.tag_id = tg.id WHERE tt.task_id IN (${ph})`,
      ids
    ),
    externalDependencies: await withStayingTitles(
      db,
      dependencies
        .filter((d) => !both(d))
        .map((d) => ({ task_id: d.task_id as string, blocks_task_id: d.blocks_task_id as string })),
      inside
    )
  }
}

/** Clears what belonged to the source hub's folders and computers (as a same-hub move). */
const LEFT_BEHIND: Readonly<Row> = {
  computer_id: null,
  worktree_computer_id: null,
  has_worktree: 0,
  has_base_dir: 0,
  repo_name: null,
  worktree_parent_branch: null,
  merge_state: null,
  merge_context: null
}

/**
 * Take a move's bundle into `targetProjectId` here — the target hub's `import` step.
 * The same rules as a move within one hub: each status this project lacks re-homes
 * to its default, a moved task whose parent did not come along is detached, the
 * paths and computer pins of the old hub are dropped, tabs come back stopped, tags
 * map by name. One `task.project_changed` entry per task. Retried: nothing changes.
 */
export async function importTaskMove(
  db: SlayzoneDb,
  input: ImportTaskMoveInput
): Promise<TaskMove> {
  const { bundle } = input
  const existing = await db.get<MoveRow>('SELECT * FROM task_moves WHERE id = ?', [bundle.moveId])
  if (existing) return toMove(db, existing)
  const target = await db.get<{ id: string; name: string; columns_config: string | null }>(
    'SELECT id, name, columns_config FROM projects WHERE id = ?',
    [input.targetProjectId]
  )
  if (!target) throw new TaskMoveRefusedError(`Project not found: ${input.targetProjectId}`)
  const columns = parseColumnsConfig(target.columns_config)
  const tasks = bundle.rows.tasks ?? []
  const taskIds = tasks.map((t) => t.id as string)
  if (taskIds.length === 0) throw new TaskMoveRefusedError('The move carries no tasks')
  const inside = new Set(taskIds)

  const events: RecordActivityEventInput[] = []
  const movedTasks = tasks.map((raw) => {
    const status = raw.status as string
    const next: Row = {
      ...raw,
      ...LEFT_BEHIND,
      project_id: target.id,
      status: isKnownStatus(status, columns) ? status : getDefaultStatus(columns),
      parent_id: raw.parent_id && inside.has(raw.parent_id as string) ? raw.parent_id : null
    }
    const before = parseTask(raw)!
    const after = parseTask(next)!
    events.push(...buildTaskUpdatedEvents(before, after))
    events.push(
      ...buildTaskProjectChangedEvents(
        before,
        { id: target.id, name: target.name },
        `another hub (${input.sourceHubId})`
      )
    )
    return next
  })
  await db.namedTxn('task:import-move', {
    moveId: bundle.moveId,
    sourceHubId: input.sourceHubId,
    targetProjectId: target.id,
    rootTaskIds: bundle.rootTaskIds,
    taskIds,
    rows: {
      ...bundle.rows,
      tasks: movedTasks,
      // Its history is filed under the project it now lives in.
      activity_events: (bundle.rows.activity_events ?? []).map((e) => ({
        ...e,
        project_id: target.id
      })),
      // Nothing runs here yet: every tab comes in stopped.
      terminal_tabs: (bundle.rows.terminal_tabs ?? []).map((t) => ({
        ...t,
        agent_state: 'stopped'
      }))
    },
    tags: bundle.tags,
    events,
    now: Date.now()
  })
  return getTaskMove(db, bundle.moveId)
}

/** The target hub takes the tasks as its own: shown, unlocked. Repeated: no change. */
export async function commitTaskMoveIn(db: SlayzoneDb, id: string): Promise<TaskMove> {
  const move = await getTaskMove(db, id)
  if (move.direction !== 'in') throw new TaskMoveStateError('Not a move into this hub')
  if (move.status === 'done') return move
  if (move.status === 'canceled') throw new TaskMoveStateError('The move was canceled')
  await setMove(db, id, { status: 'done' }, { status: TASK_MOVE_LOCKING_STATUSES })
  return getTaskMove(db, id)
}

/** A canceled move: the target hub drops what it took (before it committed). */
export async function abortTaskMoveIn(db: SlayzoneDb, id: string): Promise<TaskMove> {
  const move = await getTaskMove(db, id)
  if (move.direction !== 'in') throw new TaskMoveStateError('Not a move into this hub')
  if (move.status === 'done') throw new TaskMoveStateError('The move is committed here')
  await db.namedTxn('task:abort-import', { id, now: Date.now() })
  return getTaskMove(db, id)
}

async function withStayingTitles(
  db: SlayzoneDb,
  deps: Array<{ task_id: string; blocks_task_id: string }>,
  moved: ReadonlySet<string>
): Promise<TaskMoveBundle['externalDependencies']> {
  const staying = [
    ...new Set(deps.map((d) => (moved.has(d.task_id) ? d.blocks_task_id : d.task_id)))
  ]
  const titles = staying.length
    ? new Map(
        (
          await db.all<{ id: string; title: string }>(
            `SELECT id, title FROM tasks WHERE id IN (${placeholders(staying.length)})`,
            staying
          )
        ).map((r) => [r.id, r.title])
      )
    : new Map<string, string>()
  return deps.map((d) => ({
    ...d,
    staying_title: titles.get(moved.has(d.task_id) ? d.blocks_task_id : d.task_id) ?? ''
  }))
}

// ── blockers across hubs (slice 3d) ────────────────────────────────────────────

/**
 * Record this hub's side of blockers a move split (the `links` step, on both hubs).
 * Each link's task must be here. Repeated: nothing changes.
 */
export async function addRemoteBlockers(
  db: SlayzoneDb,
  input: {
    moveId: string
    links: Array<Omit<TaskRemoteBlocker, 'createdAt'>>
  }
): Promise<void> {
  await getTaskMove(db, input.moveId)
  const now = Date.now()
  for (const l of input.links) {
    await db.run(
      `INSERT OR IGNORE INTO task_remote_blockers
         (task_id, role, remote_hub_id, remote_task_id, remote_title, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [l.taskId, l.role, l.remoteHubId, l.remoteTaskId, l.remoteTitle, now]
    )
  }
}

/** A task's blockers on other hubs (both roles). */
export async function listRemoteBlockers(
  db: SlayzoneDb,
  taskId: string
): Promise<TaskRemoteBlocker[]> {
  const rows = await db.all<{
    task_id: string
    role: TaskRemoteBlocker['role']
    remote_hub_id: string
    remote_task_id: string
    remote_title: string | null
    created_at: number
  }>('SELECT * FROM task_remote_blockers WHERE task_id = ? ORDER BY created_at', [taskId])
  return rows.map((r) => ({
    taskId: r.task_id,
    role: r.role,
    remoteHubId: r.remote_hub_id,
    remoteTaskId: r.remote_task_id,
    remoteTitle: r.remote_title,
    createdAt: r.created_at
  }))
}

/** Remove this hub's side of one cross-hub blocker. */
export async function removeRemoteBlocker(
  db: SlayzoneDb,
  key: Pick<TaskRemoteBlocker, 'taskId' | 'role' | 'remoteHubId' | 'remoteTaskId'>
): Promise<void> {
  await db.run(
    `DELETE FROM task_remote_blockers
      WHERE task_id = ? AND role = ? AND remote_hub_id = ? AND remote_task_id = ?`,
    [key.taskId, key.role, key.remoteHubId, key.remoteTaskId]
  )
}

/** The move dialog's summary of a move to another hub (with subtasks). */
export async function previewCrossHubMove(
  db: SlayzoneDb,
  rootIds: readonly string[]
): Promise<CrossHubMovePreview> {
  const roots = [...new Set(rootIds)]
  const rph = placeholders(roots.length)
  const all = (
    await db.all<{ id: string }>(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM tasks WHERE id IN (${rph})
         UNION
         SELECT t.id FROM tasks t JOIN sub s ON t.parent_id = s.id
       )
       SELECT id FROM sub`,
      roots
    )
  ).map((r) => r.id)
  const ph = placeholders(all.length || 1)
  const ids = all.length ? all : ['']
  const linked = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM external_links WHERE task_id IN (${ph})`,
    ids
  )
  const external = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM task_dependencies
      WHERE (task_id IN (${ph})) <> (blocks_task_id IN (${ph}))`,
    [...ids, ...ids]
  )
  return {
    subtaskCount: Math.max(0, all.length - roots.length),
    linkedToIntegration: (linked?.n ?? 0) > 0,
    externalBlockerCount: external?.n ?? 0,
    alreadyMoving: (await lockedTaskIds(db, all)).length > 0
  }
}
