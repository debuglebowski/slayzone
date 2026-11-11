/**
 * A task's worktree path and base dir live only on the computer holding the task's
 * folders (robustness plan §9, P0; Phase 7a, migration v210; Phase 7e, v211: the hub
 * keeps no copy). That computer runs every write (chat-runtime task-paths.ts).
 *
 * - **Holder.** `tasks.worktree_computer_id` — the computer the task's folders are
 *   on. The task's work runs there while it has a folder (computers store
 *   `resolveTaskComputerId`). A task with no recorded holder (a hand-set path on an
 *   unplaced task) gets the computer its first write reached ({@link recordHolder}).
 * - **Writes.** Every hub writer (task ops) reports its change here
 *   ({@link changed}) with the values it wrote — the hub keeps only whether each path
 *   is set (`has_worktree`, `has_base_dir`):
 *     - connected: first the task's older staged row (`flushTask`), then the
 *       operation — `set` (a partial patch), `inherit` (the computer copies the
 *       parent's row it holds), `clear` (archive);
 *     - not connected (or the call failed): staged in `computer_data_handoff`
 *       (kind `task-path`, keyed by task), merged into an older staged row, and
 *       delivered on the computer's next connect or before the task's next start.
 *   Every write carries the moment the hub accepted it (`at`); the computer keeps
 *   the newest, so a staged row delivered after a later live write never rolls it
 *   back. Never throws into the hub's write.
 * - **Checkout removal.** {@link release} asks the holder for the worktree to remove
 *   and whether a live task shares it; {@link forget} lets a purged task's path go.
 *
 * @module hub/computer-task-paths
 */
import {
  TaskFoldersUnavailableError,
  type TaskPathChange,
  type TaskPathRelease,
  type TaskPathsDelegate
} from '@slayzone/task/server'
import type { TaskPathState } from '@slayzone/task-contracts'
import type { SlayzoneDb } from '@slayzone/platform'

/** The handoff kind of a task's paths (chat-runtime `taskPathImport`). */
export const TASK_PATH_KIND = 'task-path'
/** What a path read or write waits for: the task's staged paths, never its history. */
const PATH_KINDS: readonly string[] = [TASK_PATH_KIND]

export interface ComputerTaskPathsDeps {
  db: SlayzoneDb
  /** The computer a kind of the task's data goes to now (`ComputerDataHandoff.targetOf`). */
  targetOf(kind: string, taskId: string): Promise<string | null>
  /**
   * Deliver what the hub still holds of the task there first, only `kinds` when
   * given (`ComputerDataHandoff.flushTask`).
   */
  flushTask(taskId: string, computerId: string, kinds?: readonly string[]): Promise<void>
  /** Whether that computer is connected and usable now. */
  usable(computerId: string): boolean
  /** A `chat.request` to the computer (through the lifecycle barrier in production). */
  request(computerId: string, request: unknown): Promise<unknown>
  /** Wall clock (ms). */
  now?(): number
  log?(message: string, error: unknown): void
}

/** Thrown when the computer holding a task's folders cannot be asked now. */
export class TaskFoldersOfflineError extends TaskFoldersUnavailableError {
  constructor(
    readonly taskId: string,
    readonly computerId: string | null
  ) {
    super(
      computerId
        ? `The folders of task ${taskId} are on computer ${computerId}, which is not connected`
        : `No computer holds the folders of task ${taskId} yet`
    )
  }
  override name = 'TaskFoldersOfflineError'
}

/** A staged `task-path` row (chat-runtime `taskPathValueSchema`). */
interface StagedPaths {
  projectId: string | null
  worktreePath?: string | null
  baseDir?: string | null
  inheritFrom?: string
  at: number
}

/**
 * The computer holding a task's folders: its recorded holder, else the task's data
 * computer (a holder is then recorded by the first write that reaches one). A holder
 * removed for good took the folders with it: the task's data computer then.
 */
export function taskPathTarget(db: SlayzoneDb) {
  return async (taskId: string, fallback: () => Promise<string | null>) => {
    const row = await db.get<{ worktree_computer_id: string | null }>(
      `SELECT t.worktree_computer_id FROM tasks t WHERE t.id=? AND NOT EXISTS(
         SELECT 1 FROM computer_retirements r
          WHERE r.computer_id=t.worktree_computer_id AND r.successor_id IS NULL)`,
      [taskId]
    )
    return row?.worktree_computer_id ?? (await fallback())
  }
}

/** The computer a write of the task's paths reached holds its folders now (if none was recorded). */
export async function recordHolder(db: SlayzoneDb, taskId: string, computerId: string) {
  await db.run(
    `UPDATE tasks SET worktree_computer_id=? WHERE id=? AND worktree_computer_id IS NULL
      AND (has_worktree=1 OR has_base_dir=1)`,
    [computerId, taskId]
  )
}

/**
 * A path given as '' is unset (null): a computer takes only absolute paths, and a ''
 * it refuses would fault the task's staged row for good (found by the migration persona
 * suite, tools/migration-personas, p10-v0380-worktrees). Absent stays absent.
 */
function unsetEmpty<T extends { worktreePath?: string | null; baseDir?: string | null }>(p: T): T {
  return {
    ...p,
    ...(p.worktreePath === '' ? { worktreePath: null } : {}),
    ...(p.baseDir === '' ? { baseDir: null } : {})
  }
}

export function createComputerTaskPaths(deps: ComputerTaskPathsDeps): TaskPathsDelegate {
  const { db } = deps
  let last = 0
  /** Strictly increasing: two writes in one millisecond still order. */
  const now = () => {
    last = Math.max(last + 1, deps.now?.() ?? Date.now())
    return last
  }
  const log = deps.log ?? ((message, error) => console.warn(`[task-paths] ${message}`, error))

  const projectOf = async (taskId: string) =>
    db.get<{ project_id: string | null }>('SELECT project_id FROM tasks WHERE id=?', [taskId])

  /** The staged row of a change, merged into the task's older staged row. */
  async function stage(taskId: string, value: StagedPaths): Promise<void> {
    const old = await db.get<{ payload: string }>(
      'SELECT payload FROM computer_data_handoff WHERE kind=? AND item_key=?',
      [TASK_PATH_KIND, taskId]
    )
    let merged: StagedPaths = value
    if (old) {
      const prior = JSON.parse(old.payload) as StagedPaths
      // An inherit replaces every earlier value; later fields override earlier ones.
      merged = value.inheritFrom
        ? value
        : {
            ...prior,
            ...Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)),
            at: value.at
          }
    }
    await db.run(
      `INSERT INTO computer_data_handoff(kind,item_key,task_id,payload,created_at) VALUES(?,?,?,?,?)
       ON CONFLICT(kind,item_key) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at`,
      [TASK_PATH_KIND, taskId, taskId, JSON.stringify(merged), value.at]
    )
  }

  const call = (computerId: string, value: Record<string, unknown>) =>
    deps.request(computerId, { kind: 'taskPaths', value })

  /** The change as a staged value (what the computer applies on delivery). */
  function stagedOf(change: TaskPathChange, projectId: string | null, at: number): StagedPaths {
    if (change.op === 'clear') return { projectId, worktreePath: null, baseDir: null, at }
    if (change.op === 'inherit') return { projectId, inheritFrom: change.parentTaskId, at }
    return {
      projectId,
      ...(change.worktreePath !== undefined ? { worktreePath: change.worktreePath } : {}),
      ...(change.baseDir !== undefined ? { baseDir: change.baseDir } : {}),
      at
    }
  }

  async function run(taskId: string, change: TaskPathChange, projectId: string | null, at: number) {
    const computerId = await deps.targetOf(TASK_PATH_KIND, taskId)
    if (computerId === null || !deps.usable(computerId)) return false
    await deps.flushTask(taskId, computerId, PATH_KINDS)
    if (change.op === 'clear') {
      await call(computerId, { op: 'clear', taskId, at })
      return true
    }
    if (change.op === 'inherit') {
      await deps.flushTask(change.parentTaskId, computerId, PATH_KINDS)
      await call(computerId, {
        op: 'inherit',
        taskId,
        parentTaskId: change.parentTaskId,
        projectId,
        at
      })
      // A parent this computer does not hold has no paths here: nothing to copy.
    } else {
      await call(computerId, {
        op: 'set',
        taskId,
        projectId,
        ...(change.worktreePath !== undefined ? { worktreePath: change.worktreePath } : {}),
        ...(change.baseDir !== undefined ? { baseDir: change.baseDir } : {}),
        at
      })
    }
    await recordHolder(db, taskId, computerId)
    return true
  }

  /** The connected holder of a task's folders, with the hub's staged row delivered. */
  async function holder(taskId: string): Promise<string> {
    const computerId = await deps.targetOf(TASK_PATH_KIND, taskId)
    if (computerId === null || !deps.usable(computerId))
      throw new TaskFoldersOfflineError(taskId, computerId)
    await deps.flushTask(taskId, computerId, PATH_KINDS)
    return computerId
  }

  return {
    async read(taskIds) {
      // Group by the computer holding each task's paths; one `get` per computer.
      const out: Record<string, TaskPathState> = {}
      const byComputer = new Map<string, string[]>()
      for (const taskId of taskIds) {
        const computerId = await deps.targetOf(TASK_PATH_KIND, taskId)
        if (computerId === null || !deps.usable(computerId)) {
          out[taskId] = { state: 'offline', computerId }
          continue
        }
        const list = byComputer.get(computerId) ?? []
        list.push(taskId)
        byComputer.set(computerId, list)
      }
      for (const [computerId, all] of byComputer) {
        // A row the hub still stages goes first: the read never misses it. Only the
        // task's paths (never its history), and per task: one task whose row cannot
        // be delivered is offline on its own; the batch's others still answer.
        const ids: string[] = []
        for (const id of all) {
          try {
            await deps.flushTask(id, computerId, PATH_KINDS)
            ids.push(id)
          } catch (error) {
            log(`staged paths of ${id} not delivered to ${computerId}`, error)
            out[id] = { state: 'offline', computerId }
          }
        }
        if (ids.length === 0) continue
        try {
          const rows = (await call(computerId, { op: 'get', taskIds: ids })) as Array<{
            taskId: string
            worktreePath: string | null
            baseDir: string | null
          }>
          if (!Array.isArray(rows)) throw new Error('Invalid task paths answer')
          const held = new Map(rows.map((r) => [r.taskId, r]))
          for (const id of ids) {
            const row = held.get(id)
            out[id] = {
              state: 'ok',
              worktreePath: row?.worktreePath ?? null,
              baseDir: row?.baseDir ?? null
            }
          }
        } catch (error) {
          // It went away mid-read (or could not answer): as offline, never a guess.
          log(`paths of ${ids.length} task(s) unreadable on ${computerId}`, error)
          for (const id of ids) out[id] = { state: 'offline', computerId }
        }
      }
      return out
    },

    async changed(taskId, given) {
      const change = given.op === 'set' ? unsetEmpty(given) : given
      const at = now()
      const row = await projectOf(taskId)
      if (!row) return
      try {
        if (await run(taskId, change, row.project_id, at)) return
      } catch (error) {
        log(`paths of ${taskId} staged for its computer`, error)
      }
      await stage(taskId, stagedOf(change, row.project_id, at))
    },

    async release(taskId, liveTaskIds): Promise<TaskPathRelease> {
      const computerId = await holder(taskId)
      const answer = (await call(computerId, {
        op: 'release',
        taskId,
        liveTaskIds: [...liveTaskIds]
      })) as TaskPathRelease
      if (!answer || typeof answer.shared !== 'boolean')
        throw new Error('Invalid task path release answer')
      return { ...answer, computerId }
    },

    async apply(taskId, given) {
      const patch = unsetEmpty(given)
      // A task with no folder has no holder, nor one on a computer removed for good
      // (its folders went with it): a stale one goes, so the new folder is on the
      // computer the task's work runs on now.
      await db.run(
        `UPDATE tasks SET worktree_computer_id=NULL
          WHERE id=? AND worktree_computer_id IS NOT NULL
            AND ((has_worktree=0 AND has_base_dir=0) OR EXISTS(
              SELECT 1 FROM computer_retirements r
               WHERE r.computer_id=tasks.worktree_computer_id AND r.successor_id IS NULL))`,
        [taskId]
      )
      const row = await projectOf(taskId)
      if (!row) throw new Error(`Task ${taskId} not found`)
      const computerId = await holder(taskId)
      await call(computerId, {
        op: 'set',
        taskId,
        projectId: row.project_id,
        ...(patch.worktreePath !== undefined ? { worktreePath: patch.worktreePath } : {}),
        ...(patch.baseDir !== undefined ? { baseDir: patch.baseDir } : {}),
        at: now()
      })
      await db.run(
        'UPDATE tasks SET worktree_computer_id=? WHERE id=? AND worktree_computer_id IS NULL',
        [computerId, taskId]
      )
    },

    async forget(taskId, computerId) {
      if (!deps.usable(computerId)) return
      await call(computerId, { op: 'forget', taskId }).catch((error: unknown) =>
        log(`purged path of ${taskId} not forgotten on ${computerId} (it expires)`, error)
      )
    }
  }
}

/**
 * The folders (worktree, base dir) of the tasks a computer holds, as THAT computer
 * reports them (§9 Phase 7c): the hub's own disk is decided by its own computer's
 * report, never by a hub copy. Asks only for the tasks the hub places there.
 * Throws when the computer cannot answer — the caller then has no such folders.
 */
export async function readComputerTaskRoots(
  deps: Pick<ComputerTaskPathsDeps, 'db' | 'request' | 'usable'>,
  computerId: string,
  /** Only these tasks (default: every task the hub places there). */
  taskIds?: readonly string[]
): Promise<Array<{ taskId: string; root: string }>> {
  if (!deps.usable(computerId)) throw new Error(`computer ${computerId} is not connected`)
  const ids =
    taskIds ??
    (
      await deps.db.all<{ id: string }>(
        'SELECT id FROM tasks WHERE computer_id=? OR worktree_computer_id=?',
        [computerId, computerId]
      )
    ).map((r) => r.id)
  const roots: Array<{ taskId: string; root: string }> = []
  for (let i = 0; i < ids.length; i += 5000) {
    const rows = (await deps.request(computerId, {
      kind: 'taskPaths',
      value: { op: 'get', taskIds: ids.slice(i, i + 5000) }
    })) as Array<{ taskId: string; worktreePath: string | null; baseDir: string | null }>
    if (!Array.isArray(rows)) throw new Error('Invalid task paths answer')
    for (const row of rows) {
      if (row.worktreePath) roots.push({ taskId: row.taskId, root: row.worktreePath })
      if (row.baseDir) roots.push({ taskId: row.taskId, root: row.baseDir })
    }
  }
  return roots
}

/**
 * One task's paths as `computerId` holds them, after delivering what the hub still
 * holds for it there (§9 Phase 7c). Null: none there. Throws when it cannot answer.
 */
export async function readComputerTaskPath(
  deps: Pick<ComputerTaskPathsDeps, 'request' | 'usable' | 'flushTask'>,
  computerId: string,
  taskId: string
): Promise<{ worktreePath: string | null; baseDir: string | null } | null> {
  if (!deps.usable(computerId)) throw new Error(`computer ${computerId} is not connected`)
  await deps.flushTask(taskId, computerId, PATH_KINDS)
  const rows = (await deps.request(computerId, {
    kind: 'taskPaths',
    value: { op: 'get', taskIds: [taskId] }
  })) as Array<{ taskId: string; worktreePath: string | null; baseDir: string | null }>
  if (!Array.isArray(rows)) throw new Error('Invalid task paths answer')
  const row = rows.find((r) => r.taskId === taskId)
  return row ? { worktreePath: row.worktreePath, baseDir: row.baseDir } : null
}
