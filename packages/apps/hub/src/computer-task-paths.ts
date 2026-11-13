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
import { createHash } from 'node:crypto'
import {
  InvalidTaskUpdateError,
  TaskFoldersUnavailableError,
  type TaskPathChange,
  type TaskPathPatch,
  type TaskPathRelease,
  type TaskPathsDelegate
} from '@slayzone/task/server'
import type { TaskPathState } from '@slayzone/task-contracts'
import type { SlayzoneDb } from '@slayzone/platform'
import type { FaultLedger } from '@slayzone/platform/isolation'
import { normalizeTaskPath } from '@slayzone/chat-runtime/shared'
import type { HandoffKind } from './computer-data-handoff'

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
  /** The hub's own Needs-attention ledger: a path no computer takes is recorded there. */
  ledger?: FaultLedger
}

/** Needs-attention pass of a task path no computer takes (item key `<taskId>:<field>`). */
export const TASK_PATH_REFUSED_PASS = 'hub-task-path'

const FIELDS = ['worktreePath', 'baseDir'] as const
type PathField = (typeof FIELDS)[number]
const FLAG: Record<PathField, string> = { worktreePath: 'has_worktree', baseDir: 'has_base_dir' }
const LABEL: Record<PathField, string> = { worktreePath: 'worktree path', baseDir: 'base dir' }

/** A path the user set that no computer takes (relative, `~/…`, blank): the update fails. */
export class InvalidTaskPathError extends InvalidTaskUpdateError {
  constructor(
    readonly field: PathField,
    readonly value: string
  ) {
    super(`The ${LABEL[field]} must be an absolute path on the computer: ${JSON.stringify(value)}`)
  }
  override name = 'InvalidTaskPathError'
}

/**
 * Judges the paths of one write, once, as a computer would ({@link normalizeTaskPath}):
 * `''` is unset; a path no computer takes is never sent nor staged. Where nobody can be
 * told at once (any writer but the user's own `apply`, a row staged before this check),
 * it is left unset — the task's flag too, as no computer holds it — and Needs attention
 * says so. A later write of that path ends the entry.
 */
function createTaskPathJudge(
  db: SlayzoneDb,
  opts: { ledger?: FaultLedger; log(message: string, error: unknown): void }
) {
  return {
    /** The fields as sent; throws {@link InvalidTaskPathError} on one no computer takes. */
    strict(patch: TaskPathPatch): TaskPathPatch {
      const out: TaskPathPatch = {}
      for (const field of FIELDS) {
        if (!(field in patch)) continue
        const given = patch[field]
        const judged = normalizeTaskPath(given)
        if (!judged.ok) throw new InvalidTaskPathError(field, String(given))
        out[field] = judged.value
      }
      return out
    },
    /**
     * The fields as sent: one no computer takes is unset, its flag cleared, recorded.
     * `accepted`: the fields written as given (their earlier refusal is over once sent).
     */
    async lenient<T extends TaskPathPatch>(
      taskId: string,
      patch: T
    ): Promise<{ patch: T; accepted: PathField[] }> {
      const out = { ...patch }
      const accepted: PathField[] = []
      for (const field of FIELDS) {
        if (!(field in patch)) continue
        const given = patch[field]
        const judged = normalizeTaskPath(given)
        if (judged.ok) {
          out[field] = judged.value as T[PathField]
          accepted.push(field)
          continue
        }
        out[field] = null as T[PathField]
        const error = new Error(
          `The ${LABEL[field]} ${JSON.stringify(given)} is not an absolute path, so no computer can hold it: it was left unset. Set the task's folder again.`
        )
        opts.log(`${LABEL[field]} of ${taskId} refused`, error)
        await db.run(`UPDATE tasks SET ${FLAG[field]}=0 WHERE id=?`, [taskId])
        await opts.ledger?.record(
          {
            pass: TASK_PATH_REFUSED_PASS,
            itemKey: `${taskId}:${field}`,
            taskId,
            kind: 'structural',
            // Lifted by a change: the next write of this path (`settled`).
            fingerprint: createHash('sha256').update(String(given)).digest('hex'),
            error
          },
          Date.now()
        )
      }
      return { patch: out, accepted }
    },
    /** These fields were written as given: an earlier refusal of them is over. */
    async settled(taskId: string, fields: readonly PathField[]): Promise<void> {
      for (const field of fields)
        await opts.ledger?.clear(TASK_PATH_REFUSED_PASS, `${taskId}:${field}`)
    }
  }
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

/** The computer recorded as holding a task's folders, unless it was removed for good. */
async function recordedHolder(db: SlayzoneDb, taskId: string): Promise<string | null> {
  const row = await db.get<{ worktree_computer_id: string | null }>(
    `SELECT t.worktree_computer_id FROM tasks t WHERE t.id=? AND NOT EXISTS(
       SELECT 1 FROM computer_retirements r
        WHERE r.computer_id=t.worktree_computer_id AND r.successor_id IS NULL)`,
    [taskId]
  )
  return row?.worktree_computer_id ?? null
}

/**
 * The computer holding a task's folders: its recorded holder (a holder removed for
 * good took the folders with it: none). Without one, a subtask whose inherit is still
 * staged goes where its parent's paths go — its folders are the parent's, and only
 * the computer that gets the parent's row can copy it (a parent's own holder may not
 * be recorded yet: its row staged for its chat's computer, or no computer placed).
 * Else the task's data computer; a holder is then recorded by the first write that
 * reaches one.
 */
async function taskPathTarget(
  db: SlayzoneDb,
  taskId: string,
  dataTarget: (taskId: string) => Promise<string | null>,
  seen: ReadonlySet<string> = new Set()
): Promise<string | null> {
  const holder = await recordedHolder(db, taskId)
  if (holder !== null) return holder
  const staged = await db.get<{ parent: string | null }>(
    `SELECT json_extract(payload,'$.inheritFrom') AS parent FROM computer_data_handoff
      WHERE kind=? AND item_key=? AND json_valid(payload)`,
    [TASK_PATH_KIND, taskId]
  )
  const parent = staged?.parent
  if (typeof parent === 'string' && parent !== taskId && !seen.has(parent))
    return taskPathTarget(db, parent, dataTarget, new Set([...seen, taskId]))
  return dataTarget(taskId)
}

/**
 * How the hand-off delivers `task-path` rows: to the computer holding the task's
 * folders; a path no computer takes (a row staged before the delegate judged paths)
 * is sent unset, with its Needs-attention entry, instead of faulting the row for good.
 */
export function taskPathHandoffKind(
  db: SlayzoneDb,
  opts: { ledger?: FaultLedger; log?(message: string, error: unknown): void } = {}
): HandoffKind {
  const judge = createTaskPathJudge(db, {
    ledger: opts.ledger,
    log: opts.log ?? ((message, error) => console.warn(`[task-paths] ${message}`, error))
  })
  return {
    target: (taskId, dataTarget) => taskPathTarget(db, taskId, dataTarget),
    async prepare(taskId, value) {
      if (typeof value !== 'object' || value === null) return value
      return (await judge.lenient(taskId, value as TaskPathPatch)).patch
    },
    // A subtask's inherit copies its parent's row as the computer holds it: that row
    // goes first, or the copy is empty.
    after: (value) => {
      const parent = (value as { inheritFrom?: unknown } | null)?.inheritFrom
      return typeof parent === 'string' ? [parent] : []
    }
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

export function createComputerTaskPaths(deps: ComputerTaskPathsDeps): TaskPathsDelegate {
  const { db } = deps
  let last = 0
  /** Strictly increasing: two writes in one millisecond still order. */
  const now = () => {
    last = Math.max(last + 1, deps.now?.() ?? Date.now())
    return last
  }
  const log = deps.log ?? ((message, error) => console.warn(`[task-paths] ${message}`, error))
  const judge = createTaskPathJudge(db, { ledger: deps.ledger, log })

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
    // An inherit with no recorded holder goes where the parent's paths go (the
    // computer that can copy them), as its staged row would (`taskPathTarget`).
    const computerId =
      change.op === 'inherit' && (await recordedHolder(db, taskId)) === null
        ? await deps.targetOf(TASK_PATH_KIND, change.parentTaskId)
        : await deps.targetOf(TASK_PATH_KIND, taskId)
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
      const row = await projectOf(taskId)
      if (!row) return
      // Judged once, here: nothing a computer refuses is ever sent or staged.
      const judged = given.op === 'set' ? await judge.lenient(taskId, given) : null
      const change = judged ? judged.patch : given
      const at = now()
      let sent = false
      try {
        sent = await run(taskId, change, row.project_id, at)
      } catch (error) {
        log(`paths of ${taskId} staged for its computer`, error)
      }
      if (!sent) await stage(taskId, stagedOf(change, row.project_id, at))
      if (judged) await judge.settled(taskId, judged.accepted)
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
      // The user's own write: a path no computer takes fails it, before any computer.
      const patch = judge.strict(given)
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
      await judge.settled(
        taskId,
        FIELDS.filter((field) => field in patch)
      )
      return patch
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
