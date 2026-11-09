import type { Database } from 'better-sqlite3'
import type { TxnSigOf } from '@slayzone/platform'
import type { RecordActivityEventInput } from '@slayzone/history/recorder'
import { recordActivityEvents } from '@slayzone/history/recorder'

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

/** Record an arbitrary, already-built activity-event list inside its own txn. */
function recordEvents(db: Database, p: { events: RecordActivityEventInput[] }): void {
  if (p.events.length === 0) return
  db.transaction(() => {
    recordActivityEvents(db, p.events)
  })()
}

/**
 * Hard-delete expired Trash rows (startup-purge.ts). Deleting a task moves only that
 * task to Trash — its subtasks stay — but `tasks.parent_id` is `ON DELETE CASCADE`, so a
 * plain DELETE would take every descendant with it. A child that is not itself purged
 * here (live, still restorable from Trash, or expired but kept until its computer
 * connects) first moves up to its nearest ancestor that stays, else to the top level.
 * One transaction, the tree read inside it: a subtask added under a purged task
 * meanwhile is caught too. Returns the moved tasks so the caller can announce them.
 */
function purge(
  db: Database,
  p: { ids: string[] }
): { deleted: number; reparented: { id: string; projectId: string }[] } {
  return db.transaction(() => {
    const purging = new Set(p.ids)
    const parentOf = db.prepare('SELECT parent_id FROM tasks WHERE id = ?')
    const childrenOf = db.prepare('SELECT id, project_id FROM tasks WHERE parent_id = ?')
    const setParent = db.prepare(
      `UPDATE tasks SET parent_id = ?, updated_at = datetime('now') WHERE id = ?`
    )
    const remove = db.prepare('DELETE FROM tasks WHERE id = ?')
    /** Nearest ancestor of `id` that is not purged, or null. Cycle-safe. */
    const keptAncestor = (id: string): string | null => {
      const seen = new Set<string>([id])
      let cursor = (parentOf.get(id) as { parent_id: string | null } | undefined)?.parent_id
      while (cursor && !seen.has(cursor)) {
        if (!purging.has(cursor)) return cursor
        seen.add(cursor)
        cursor = (parentOf.get(cursor) as { parent_id: string | null } | undefined)?.parent_id
      }
      return null
    }
    const reparented: { id: string; projectId: string }[] = []
    for (const id of p.ids) {
      const kept = (childrenOf.all(id) as { id: string; project_id: string }[]).filter(
        (c) => !purging.has(c.id)
      )
      if (kept.length === 0) continue
      const target = keptAncestor(id)
      for (const child of kept) {
        setParent.run(target, child.id)
        reparented.push({ id: child.id, projectId: child.project_id })
      }
    }
    let deleted = 0
    for (const id of p.ids) deleted += remove.run(id).changes
    return { deleted, reparented }
  })()
}

export const taskTxns = {
  'task:insert-row': insertRow,
  'task:soft-delete': softDelete,
  'task:soft-delete-many': softDeleteMany,
  'task:archive': archive,
  'task:update': update,
  'task:record-events': recordEvents,
  'task:purge': purge
}

// Types `db.namedTxn(...)` for these names. Every file that calls one imports this
// module (`import type {} from ...`), so any program that checks the call also loads
// this augmentation — see `TxnRegistry` in @slayzone/platform.
declare module '@slayzone/platform' {
  interface TxnRegistry extends TxnSigOf<typeof taskTxns> {}
}
