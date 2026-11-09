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
import { assertPathSafeId, containedPath } from '@slayzone/platform/safe-path'

interface Candidates {
  attachments: string[]
  artifacts: string[]
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
  db.transaction(() => {
    for (const table of ['blob_leases', 'artifact_blob_leases'])
      if (
        has(db, table) &&
        db.prepare(`SELECT 1 FROM ${table} WHERE expires_at>? LIMIT 1`).get(Date.now())
      )
        throw new Error('A backup lease is still using computer files')
    for (const table of ['events', 'records', 'receipts'])
      db.prepare(
        `DELETE FROM ${table} WHERE conversation_id IN(SELECT id FROM conversations WHERE task_id=?)`
      ).run(taskId)
    for (const table of [
      'provider_configs',
      'queue_message_identities',
      'task_artifacts',
      'artifact_folders'
    ])
      if (has(db, table)) db.prepare(`DELETE FROM ${table} WHERE task_id=?`).run(taskId)
    if (has(db, 'migration_checkpoints'))
      db.prepare("DELETE FROM migration_checkpoints WHERE json_extract(identity,'$.taskId')=?").run(
        taskId
      )
    db.prepare(
      "UPDATE conversations SET state='deleted',migration_id=NULL,migration_hash=NULL WHERE task_id=?"
    ).run(taskId)
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
      if (has(db, 'artifact_blobs')) db.prepare('DELETE FROM artifact_blobs WHERE hash=?').run(hash)
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
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).taskId === taskId)
        erase(path)
    }
  for (const table of ['events', 'records', 'receipts'])
    if (
      db
        .prepare(
          `SELECT 1 FROM ${table} WHERE conversation_id IN(SELECT id FROM conversations WHERE task_id=?) LIMIT 1`
        )
        .get(taskId)
    )
      throw new Error('Computer content remains')
  db.exec('VACUUM')
  const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>
  if (checkpoint.some((row) => row.busy)) throw new Error('Computer checkpoint is busy')
}
