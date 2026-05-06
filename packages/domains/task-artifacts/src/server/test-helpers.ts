import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BlobStore } from './blob-store'
import { nodeSqliteTxn, type DbLike, type TxnRunner } from './db'

export interface TestEnv {
  db: DbLike
  txn: TxnRunner
  blobStore: BlobStore
  dataDir: string
  cleanup: () => void
  insertArtifact: (id: string, taskId?: string, title?: string) => void
}

const SCHEMA = `
  CREATE TABLE task_artifacts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    current_version_id TEXT
  );
  CREATE TABLE artifact_versions (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES task_artifacts(id) ON DELETE CASCADE,
    version_num INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    name TEXT,
    author_type TEXT,
    author_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    parent_id TEXT REFERENCES artifact_versions(id) ON DELETE SET NULL
  );
  CREATE UNIQUE INDEX idx_artifact_versions_num ON artifact_versions(artifact_id, version_num);
  CREATE UNIQUE INDEX idx_artifact_versions_name ON artifact_versions(artifact_id, name) WHERE name IS NOT NULL;
  CREATE INDEX idx_artifact_versions_hash ON artifact_versions(content_hash);
  CREATE INDEX idx_artifact_versions_parent ON artifact_versions(parent_id);
  CREATE TABLE artifact_blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL);
`

export function makeTestEnv(): TestEnv {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'task-artifacts-test-'))
  const realDb = new DatabaseSync(':memory:')
  realDb.exec('PRAGMA foreign_keys = ON;')
  realDb.exec(SCHEMA)
  const blobStore = new BlobStore(dataDir)
  const txn = nodeSqliteTxn(realDb)

  return {
    db: realDb as unknown as DbLike,
    txn,
    blobStore,
    dataDir,
    cleanup: () => {
      realDb.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
    insertArtifact: (id, taskId = 'task-1', title = 'note.md') => {
      realDb.prepare('INSERT INTO task_artifacts (id, task_id, title) VALUES (?, ?, ?)').run(id, taskId, title)
    },
  }
}
