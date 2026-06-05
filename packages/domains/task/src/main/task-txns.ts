import type { Database } from 'better-sqlite3'
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

export const taskTxns = {
  'task:insert-row': insertRow,
  'task:soft-delete': softDelete,
  'task:soft-delete-many': softDeleteMany,
  'task:archive': archive,
  'task:update': update,
  'task:record-events': recordEvents
}
