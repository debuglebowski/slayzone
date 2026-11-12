import type { Database } from 'better-sqlite3'
import type { TxnSigOf } from '@slayzone/platform'
import type { RecordActivityEventInput } from '@slayzone/history/recorder'
import { recordActivityEvents } from '@slayzone/history/recorder'
import { projectTagsByName, remapTaskTagsToProject } from '@slayzone/tags/db'

/**
 * Named-transaction adapters for the task domain. These are the conditional
 * read-modify-write operations that bundle a task-row write with an activity-log
 * write and must commit atomically — they can't be a static `batchTxn` op list
 * because the activity events are derived from parsed task state, and they can't
 * split across the worker boundary. Registered into the worker's txn registry
 * via `@slayzone/task/db`. Each function owns its own `db.transaction(...)`, so
 * the worker invokes it directly without re-wrapping.
 *
 * Pure: imports only better-sqlite3 + the worker-safe `@slayzone/history/recorder`
 * surface (no electron / node-pty at runtime), so it is safe to pull into the
 * worker bundle (unlike the electron/worktree-laden `./ops/shared` module where
 * the calling ops live).
 *
 * The caller (main process) does all reading + parsing + event-building, then
 * hands prepared SQL params and the already-built `events` list to these
 * functions. The functions only execute the writes atomically.
 */

/** Insert a task row + record its `task.created` activity events atomically. */
function insertRow(
  db: Database,
  p: { insertSql: string; insertParams: unknown[]; events: RecordActivityEventInput[] }
): { changes: number } {
  return db.transaction(() => {
    const info = db.prepare(p.insertSql).run(...p.insertParams)
    if (info.changes > 0 && p.events.length > 0) {
      recordActivityEvents(db, p.events)
    }
    return { changes: info.changes }
  })()
}

/**
 * Run a single soft-delete UPDATE and, when it changed a row, record the
 * provided `task.deleted` events — atomically. Returns the row count so the
 * caller can decide whether to emit follow-up IPC/events.
 */
function softDelete(
  db: Database,
  p: { sql: string; params: unknown[]; events: RecordActivityEventInput[] }
): { changes: number } {
  return db.transaction(() => {
    const info = db.prepare(p.sql).run(...p.params)
    if (info.changes > 0 && p.events.length > 0) {
      recordActivityEvents(db, p.events)
    }
    return { changes: info.changes }
  })()
}

/**
 * Soft-delete a batch of tasks. Each op is `{ id, sql, params, events }`. Runs
 * every UPDATE inside one transaction, recording deletion events only for rows
 * that actually changed. Returns the ids whose UPDATE reported a change.
 */
function softDeleteMany(
  db: Database,
  p: {
    ops: { id: string; sql: string; params: unknown[]; events: RecordActivityEventInput[] }[]
  }
): { deletedIds: string[] } {
  return db.transaction(() => {
    const deletedIds: string[] = []
    for (const op of p.ops) {
      const info = db.prepare(op.sql).run(...op.params)
      if (info.changes > 0) {
        if (op.events.length > 0) recordActivityEvents(db, op.events)
        deletedIds.push(op.id)
      }
    }
    return { deletedIds }
  })()
}

/**
 * Archive a task (or batch) via the provided UPDATE + record `task.archived`
 * events atomically. Used by both single archive and bulk archive — the caller
 * supplies the right SQL/params and the parsed event list.
 */
function archive(
  db: Database,
  p: { sql: string; params: unknown[]; events: RecordActivityEventInput[] }
): void {
  db.transaction(() => {
    db.prepare(p.sql).run(...p.params)
    if (p.events.length > 0) recordActivityEvents(db, p.events)
  })()
}

/**
 * Apply a generic task UPDATE (built by the caller) + record its activity
 * events atomically. The caller has already computed the field list, values,
 * and the diff-derived event list via `updateTask` semantics.
 */
function update(
  db: Database,
  p: { sql: string; params: unknown[]; events: RecordActivityEventInput[] }
): void {
  db.transaction(() => {
    db.prepare(p.sql).run(...p.params)
    if (p.events.length > 0) recordActivityEvents(db, p.events)
  })()
}

/**
 * Move tasks to another project in one transaction (`moveTasksToProject`): each
 * moved row gets the target project, its re-homed status, and loses what belonged
 * to the old project's folder (repo, worktree, base dir); a moved row whose parent
 * stays behind is detached (`detach`), as are subtasks left behind (`detachIds`).
 * Tags follow by name (`remapTaskTagsToProject`). Answers the tags it created.
 */
function moveProject(
  db: Database,
  p: {
    targetProjectId: string
    moves: { id: string; status: string; detach: boolean }[]
    detachIds: string[]
    events: RecordActivityEventInput[]
  }
): { createdTagIds: string[] } {
  return db.transaction(() => {
    const move = db.prepare(
      `UPDATE tasks SET project_id = ?, status = ?, repo_name = NULL, worktree_parent_branch = NULL,
         has_worktree = 0, has_base_dir = 0,
         parent_id = CASE WHEN ? = 1 THEN NULL ELSE parent_id END,
         updated_at = datetime('now')
       WHERE id = ?`
    )
    for (const m of p.moves) move.run(p.targetProjectId, m.status, m.detach ? 1 : 0, m.id)
    const detach = db.prepare(
      "UPDATE tasks SET parent_id = NULL, updated_at = datetime('now') WHERE id = ?"
    )
    for (const id of p.detachIds) detach.run(id)
    const createdTagIds = remapTaskTagsToProject(
      db,
      p.moves.map((m) => m.id),
      p.targetProjectId
    )
    if (p.events.length > 0) recordActivityEvents(db, p.events)
    return { createdTagIds }
  })()
}

/**
 * Begin a move to another hub (`beginTaskMove`): unless one of the tasks is already
 * locked by an unfinished move, write the journal row and lock the tasks — in one
 * transaction, so two moves never lock the same task. A begin retried with its id
 * answers the existing move. Answers `conflict` with the tasks already moving.
 */
function beginMove(
  db: Database,
  p: {
    id: string
    peerHubId: string
    targetProjectId: string
    rootTaskIds: string[]
    taskIds: string[]
    includeSubtasks: boolean
    createdBy: string | null
    now: number
  }
): { outcome: 'created' | 'exists' } | { outcome: 'conflict'; taskIds: string[] } {
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM task_moves WHERE id = ?').get(p.id))
      return { outcome: 'exists' as const }
    const placeholders = p.taskIds.map(() => '?').join(', ')
    const busy = db
      .prepare(
        `SELECT DISTINCT mt.task_id FROM task_move_tasks mt JOIN task_moves m ON m.id = mt.move_id
          WHERE m.status IN ('running', 'paused', 'failed') AND mt.task_id IN (${placeholders})`
      )
      .all(...p.taskIds) as Array<{ task_id: string }>
    if (busy.length > 0)
      return { outcome: 'conflict' as const, taskIds: busy.map((r) => r.task_id) }
    db.prepare(
      `INSERT INTO task_moves (id, direction, peer_hub_id, target_project_id, root_task_ids,
         include_subtasks, step, status, created_by, created_at, updated_at)
       VALUES (?, 'out', ?, ?, ?, ?, 'lock', 'running', ?, ?, ?)`
    ).run(
      p.id,
      p.peerHubId,
      p.targetProjectId,
      JSON.stringify(p.rootTaskIds),
      p.includeSubtasks ? 1 : 0,
      p.createdBy,
      p.now,
      p.now
    )
    const lock = db.prepare('INSERT INTO task_move_tasks (move_id, task_id) VALUES (?, ?)')
    for (const taskId of p.taskIds) lock.run(p.id, taskId)
    return { outcome: 'created' as const }
  })()
}

/**
 * Release a move's tasks (`releaseTaskMove`): a redirect per task (where it went),
 * the move done — its lock lifted. Retried after it is done: nothing changes.
 */
function releaseMove(db: Database, p: { id: string; now: number }): void {
  db.transaction(() => {
    const move = db.prepare('SELECT peer_hub_id FROM task_moves WHERE id = ?').get(p.id) as
      | { peer_hub_id: string }
      | undefined
    if (!move) return
    db.prepare(
      `INSERT OR REPLACE INTO task_move_redirects (task_id, hub_id, move_id, created_at)
       SELECT task_id, ?, move_id, ? FROM task_move_tasks WHERE move_id = ?`
    ).run(move.peer_hub_id, p.now, p.id)
    // The tasks are the target's now: their rows go (every child row with them, by
    // cascade) — removed, NOT erased, so a task can move back. A subtask left behind
    // (the move did not bring subtasks) is detached first: the cascade would take it.
    const moved = 'SELECT task_id FROM task_move_tasks WHERE move_id = ?'
    db.prepare(
      `UPDATE tasks SET parent_id = NULL, updated_at = datetime('now')
        WHERE parent_id IN (${moved}) AND id NOT IN (${moved})`
    ).run(p.id, p.id)
    db.prepare(`DELETE FROM tasks WHERE id IN (${moved})`).run(p.id)
    keepMovedChats(db, moved, p.id)
    db.prepare("UPDATE task_moves SET status = 'done', updated_at = ? WHERE id = ?").run(
      p.now,
      p.id
    )
  })()
}

/** The tables a move between hubs writes, in insert order (parents first). */
const IMPORT_ORDER = [
  'tasks',
  'terminal_tabs',
  'artifact_folders',
  'task_artifacts',
  'artifact_versions',
  'task_tags',
  'task_dependencies',
  'activity_events',
  'usage_records'
] as const

/**
 * Take tasks moved here from another hub (`importTaskMove`): every row of the bundle
 * with its id, in one transaction (foreign keys checked at its end), the tags mapped
 * onto this project's by name, a redirect left by an earlier move away cleared, and
 * the move's journal row ('in', waiting to commit). Until the move commits, the
 * tasks are locked and hidden. Answers `exists` for a move already taken (a retry).
 * A column this hub does not have is dropped; one it has that the source lacks takes
 * its default.
 */
function importMove(
  db: Database,
  p: {
    moveId: string
    sourceHubId: string
    targetProjectId: string
    rootTaskIds: string[]
    taskIds: string[]
    rows: Record<(typeof IMPORT_ORDER)[number], Array<Record<string, unknown>>>
    tags: Array<{ id: string; name: string; color: string; text_color: string }>
    events: RecordActivityEventInput[]
    now: number
  }
): { outcome: 'imported' | 'exists' } {
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM task_moves WHERE id = ?').get(p.moveId))
      return { outcome: 'exists' as const }
    db.pragma('defer_foreign_keys = ON')
    const tagIds = projectTagsByName(db, p.targetProjectId, p.tags)
    for (const table of IMPORT_ORDER) {
      const known = new Set(
        (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
          (c) => c.name
        )
      )
      for (const raw of p.rows[table] ?? []) {
        const row =
          table === 'task_tags' ? { ...raw, tag_id: tagIds.get(raw.tag_id as string) } : raw
        if (row.tag_id === undefined && table === 'task_tags') continue
        const cols = Object.keys(row).filter((c) => known.has(c))
        if (cols.length === 0) continue
        db.prepare(
          `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')})
           VALUES (${cols.map(() => '?').join(', ')})`
        ).run(...cols.map((c) => row[c]))
      }
    }
    const ids = p.taskIds.map(() => '?').join(', ')
    db.prepare(`DELETE FROM task_move_redirects WHERE task_id IN (${ids})`).run(...p.taskIds)
    db.prepare(
      `INSERT INTO task_moves (id, direction, peer_hub_id, target_project_id, root_task_ids,
         include_subtasks, step, status, created_at, updated_at)
       VALUES (?, 'in', ?, ?, ?, 1, 'commit', 'running', ?, ?)`
    ).run(p.moveId, p.sourceHubId, p.targetProjectId, JSON.stringify(p.rootTaskIds), p.now, p.now)
    const lock = db.prepare('INSERT INTO task_move_tasks (move_id, task_id) VALUES (?, ?)')
    for (const taskId of p.taskIds) lock.run(p.moveId, taskId)
    if (p.events.length > 0) recordActivityEvents(db, p.events)
    return { outcome: 'imported' as const }
  })()
}

/** A canceled incoming move: the tasks it brought go again (every row, by cascade). */
function abortImport(db: Database, p: { id: string; now: number }): void {
  db.transaction(() => {
    const move = db
      .prepare("SELECT status FROM task_moves WHERE id = ? AND direction = 'in'")
      .get(p.id) as { status: string } | undefined
    if (!move || move.status === 'done' || move.status === 'canceled') return
    const moved = 'SELECT task_id FROM task_move_tasks WHERE move_id = ?'
    db.prepare(`DELETE FROM tasks WHERE id IN (${moved})`).run(p.id)
    keepMovedChats(db, moved, p.id)
    db.prepare("UPDATE task_moves SET status = 'canceled', updated_at = ? WHERE id = ?").run(
      p.now,
      p.id
    )
  })()
}

/**
 * Rows leaving this hub by a move are not deleted content: undo what the delete
 * triggers (`chat_task_purge`, `chat_tab_purge`) queued for them, in the same
 * transaction, so this hub's computers are never told to erase the tasks' chats and
 * terminal history, nor to tombstone the task ids (which would refuse the tasks for
 * good, a move back included). Their ownership rows stay, marked deleted: this hub no
 * longer owns those chats. Run right after the DELETE, with the moved ids in
 * `movedSql` (a SELECT of task ids, one `?` bound to `param`).
 */
function keepMovedChats(db: Database, movedSql: string, param: string): void {
  const conversations = `SELECT id FROM chat_ownership WHERE task_id IN (${movedSql})`
  db.prepare(`DELETE FROM chat_deletion_targets WHERE conversation_id IN (${conversations})`).run(
    param
  )
  for (const table of ['chat_task_lifecycle', 'chat_lifecycle_acks', 'chat_task_computers'])
    db.prepare(`DELETE FROM ${table} WHERE task_id IN (${movedSql})`).run(param)
}

export const taskTxns = {
  'task:insert-row': insertRow,
  'task:soft-delete': softDelete,
  'task:soft-delete-many': softDeleteMany,
  'task:archive': archive,
  'task:update': update,
  'task:move-project': moveProject,
  'task:begin-move': beginMove,
  'task:release-move': releaseMove,
  'task:import-move': importMove,
  'task:abort-import': abortImport
}

// Types `db.namedTxn(...)` for these names. Every file that calls one imports this
// module (`import type {} from ...`), so any program that checks the call also loads
// this augmentation — see `TxnRegistry` in @slayzone/platform.
declare module '@slayzone/platform' {
  interface TxnRegistry extends TxnSigOf<typeof taskTxns> {}
}
