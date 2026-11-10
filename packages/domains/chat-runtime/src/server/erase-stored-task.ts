import type Database from 'better-sqlite3'
import {
  existsSync,
  rmSync,
  readdirSync,
  readFileSync,
  openSync,
  closeSync,
  fsyncSync
} from 'node:fs'
import { join, dirname } from 'node:path'
import { eraseQuarantinedForTask } from '@slayzone/platform/quarantine'
import { artifactJournalBelongsTo } from '@slayzone/content-erasure/server'
import { assertPathSafeId, containedPath } from '@slayzone/platform/safe-path'

interface Candidates {
  attachments: string[]
  artifacts: string[]
  /** A VACUUM ran after this task's content was last removed: a repeated request
   *  that removes nothing more needs no new one. */
  compacted?: boolean
}
const CONTENT_TABLES = [
  'provider_configs',
  'queue_message_identities',
  'task_artifacts',
  'artifact_folders',
  // The agent-session ledger (only here since robustness plan §9).
  'agent_sessions',
  'task_conversations',
  'session_resets',
  'session_deletions',
  'legacy_conversation_history',
  // Turn snapshots (only here since robustness plan §9, hub v207).
  'agent_turns',
  // Worktree path / base dir (only here since robustness plan §9, hub v210).
  'task_paths'
]

/** Content of this task still in the database (removed by the lifecycle purge or finish). */
function hasStoredContent(db: Database.Database, taskId: string): boolean {
  for (const table of ['events', 'records', 'receipts'])
    if (
      db
        .prepare(
          `SELECT 1 FROM ${table} WHERE conversation_id IN(SELECT id FROM conversations WHERE task_id=?) LIMIT 1`
        )
        .get(taskId)
    )
      return true
  for (const table of CONTENT_TABLES)
    if (has(db, table) && db.prepare(`SELECT 1 FROM ${table} WHERE task_id=? LIMIT 1`).get(taskId))
      return true
  return (
    has(db, 'migration_checkpoints') &&
    !!db
      .prepare(
        "SELECT 1 FROM migration_checkpoints WHERE json_extract(identity,'$.taskId')=? LIMIT 1"
      )
      .get(taskId)
  )
}
const has = (db: Database.Database, table: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
const strings = (db: Database.Database, sql: string, taskId: string) =>
  (db.prepare(sql).all(taskId) as Array<{ hash: string }>).map((r) => r.hash)

/** Capture hash-only retry evidence before a tombstone removes its source rows. */
export function prepareStoredTaskErasure(db: Database.Database, taskId: string): void {
  assertPathSafeId(taskId, 'taskId')
  if (!db.inTransaction) {
    db.pragma('secure_delete=ON')
    db.pragma('synchronous=FULL')
  }
  db.transaction(() => {
    db.exec(
      'CREATE TABLE IF NOT EXISTS task_erasure_checks(task_id TEXT PRIMARY KEY,candidates TEXT NOT NULL)'
    )
    const old = db
      .prepare('SELECT candidates FROM task_erasure_checks WHERE task_id=?')
      .get(taskId) as { candidates: string } | undefined
    const previous: Candidates = old
      ? JSON.parse(old.candidates)
      : { attachments: [], artifacts: [] }
    const candidates: Candidates = {
      // Whatever is removed after this point (here or by the lifecycle purge that
      // follows) needs a new VACUUM.
      compacted: previous.compacted === true && !hasStoredContent(db, taskId),
      attachments: [
        ...new Set([
          ...previous.attachments,
          ...strings(
            db,
            `SELECT json_extract(value,'$.contentHash') AS hash FROM records WHERE kind='attachment' AND conversation_id IN(SELECT id FROM conversations WHERE task_id=?)`,
            taskId
          )
        ])
      ],
      artifacts: [
        ...new Set([
          ...previous.artifacts,
          ...(has(db, 'artifact_versions')
            ? strings(
                db,
                `SELECT content_hash AS hash FROM artifact_versions WHERE artifact_id IN(SELECT id FROM task_artifacts WHERE task_id=?)`,
                taskId
              )
            : [])
        ])
      ]
    }
    db.prepare(
      'INSERT INTO task_erasure_checks VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET candidates=excluded.candidates'
    ).run(taskId, JSON.stringify(candidates))
  }).immediate()
}

/** Shared by live computer stores and restored, readable archive copies. */
export function finishStoredTaskErasure(db: Database.Database, root: string, taskId: string): void {
  assertPathSafeId(taskId, 'taskId')
  const saved = db
    .prepare('SELECT candidates FROM task_erasure_checks WHERE task_id=?')
    .get(taskId) as { candidates: string } | undefined
  if (!saved) throw new Error('Computer erasure inventory is missing')
  const candidates = JSON.parse(saved.candidates) as Candidates
  const erase = (path: string) => {
    rmSync(path, { recursive: true, force: true })
    if (existsSync(path)) throw new Error('Computer file remains')
    const parent = dirname(path)
    if (process.platform !== 'win32' && existsSync(parent)) {
      const fd = openSync(parent, 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
  }
  let removed = 0
  db.transaction(() => {
    for (const table of ['blob_leases', 'artifact_blob_leases'])
      if (
        has(db, table) &&
        db.prepare(`SELECT 1 FROM ${table} WHERE expires_at>? LIMIT 1`).get(Date.now())
      )
        throw new Error('A backup lease is still using computer files')
    for (const table of ['events', 'records', 'receipts'])
      removed += db
        .prepare(
          `DELETE FROM ${table} WHERE conversation_id IN(SELECT id FROM conversations WHERE task_id=?)`
        )
        .run(taskId).changes
    // The task's checkout is the hub's to remove (it asks `release`, then `forget`):
    // its worktree path waits in `task_path_releases` meanwhile (hub v211).
    if (has(db, 'task_paths') && has(db, 'task_path_releases'))
      db.prepare(
        `INSERT INTO task_path_releases(task_id, project_id, worktree_path, released_at)
         SELECT task_id, project_id, worktree_path, ? FROM task_paths
          WHERE task_id=? AND worktree_path IS NOT NULL
         ON CONFLICT(task_id) DO UPDATE SET worktree_path=excluded.worktree_path,
           project_id=excluded.project_id, released_at=excluded.released_at`
      ).run(Date.now(), taskId)
    for (const table of CONTENT_TABLES)
      if (has(db, table))
        removed += db.prepare(`DELETE FROM ${table} WHERE task_id=?`).run(taskId).changes
    if (has(db, 'migration_checkpoints'))
      removed += db
        .prepare("DELETE FROM migration_checkpoints WHERE json_extract(identity,'$.taskId')=?")
        .run(taskId).changes
    // A resumability proof is per conversation: gone once no remaining row names it.
    if (has(db, 'session_turns'))
      removed += db
        .prepare(
          `DELETE FROM session_turns
            WHERE NOT EXISTS(SELECT 1 FROM agent_sessions s WHERE s.conversation_id=session_turns.conversation_id)
              AND NOT EXISTS(SELECT 1 FROM task_conversations c WHERE c.conversation_id=session_turns.conversation_id)`
        )
        .run().changes
    removed += db
      .prepare(
        "UPDATE conversations SET state='deleted',migration_id=NULL,migration_hash=NULL WHERE task_id=? AND (state<>'deleted' OR migration_id IS NOT NULL OR migration_hash IS NOT NULL)"
      )
      .run(taskId).changes
    for (const hash of candidates.attachments) {
      if (!/^[a-f0-9]{64}$/.test(hash)) continue
      if (
        !db
          .prepare(
            "SELECT 1 FROM records WHERE kind='attachment' AND json_extract(value,'$.contentHash')=? LIMIT 1"
          )
          .get(hash)
      )
        erase(join(root, 'blobs', hash))
    }
    for (const hash of candidates.artifacts) {
      if (!/^[a-f0-9]{64}$/.test(hash)) continue
      if (db.prepare('SELECT 1 FROM artifact_versions WHERE content_hash=? LIMIT 1').get(hash))
        continue
      if (
        has(db, 'artifact_blob_pins') &&
        db.prepare('SELECT 1 FROM artifact_blob_pins WHERE content_hash=? LIMIT 1').get(hash)
      )
        continue
      erase(join(root, 'blobs', hash.slice(0, 2), hash.slice(2)))
      erase(join(root, 'blobs', '.gc', hash))
      if (has(db, 'artifact_blobs'))
        removed += db.prepare('DELETE FROM artifact_blobs WHERE hash=?').run(hash).changes
    }
  }).immediate()
  for (const directory of ['artifacts', 'assets'])
    erase(containedPath(join(root, directory), taskId))
  const staging = join(root, 'blobs', '.tmp')
  if (
    (existsSync(staging) && readdirSync(staging).length) ||
    readdirSync(root).some((name) => name.startsWith('.write-'))
  )
    throw new Error('Unattributed computer staging files remain')
  const journals = join(root, 'artifacts', '.transactions')
  if (existsSync(journals))
    for (const entry of readdirSync(journals, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = containedPath(journals, assertPathSafeId(entry.name, 'journalId'))
      const manifest = join(path, 'manifest.json')
      if (
        existsSync(manifest) &&
        artifactJournalBelongsTo(readFileSync(manifest), { taskIds: [taskId] })
      )
        erase(path)
    }
  // Quarantined files (unreadable journals, archives) that name the task.
  eraseQuarantinedForTask(root, taskId)
  for (const table of ['events', 'records', 'receipts'])
    if (
      db
        .prepare(
          `SELECT 1 FROM ${table} WHERE conversation_id IN(SELECT id FROM conversations WHERE task_id=?) LIMIT 1`
        )
        .get(taskId)
    )
      throw new Error('Computer content remains')
  // Free pages, stale cell copies in live pages and WAL frames still hold removed rows
  // (secure_delete misses the copies a page split leaves): only a VACUUM rewrites them.
  // Skipped when nothing was removed since the last one for this task.
  const vacuum = removed > 0 || candidates.compacted !== true
  if (vacuum) db.exec('VACUUM')
  const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>
  if (checkpoint.some((row) => row.busy)) throw new Error('Computer checkpoint is busy')
  if (vacuum)
    db.prepare('UPDATE task_erasure_checks SET candidates=? WHERE task_id=?').run(
      JSON.stringify({ ...candidates, compacted: true }),
      taskId
    )
}
