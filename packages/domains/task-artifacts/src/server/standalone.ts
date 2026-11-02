import type Database from 'better-sqlite3'
import type { SlayzoneDb, PreparedBridge, BatchOp } from '@slayzone/platform'
import { createArtifactStore } from './artifact-store'
import { artifactsTxns } from './artifact-store-txns'

/** Artifact-owned schema: computers reuse the full artifact implementation without hub tables. */
export function createStandaloneArtifacts(
  raw: Database.Database,
  dataDir: string,
  beforeWrite: () => void = () => {}
) {
  raw.pragma('foreign_keys=ON')
  raw.exec(`
 CREATE TABLE IF NOT EXISTS artifact_storage_schema(version INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS artifact_folders (
  id TEXT PRIMARY KEY,task_id TEXT NOT NULL,parent_id TEXT REFERENCES artifact_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,"order" INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT(datetime('now'))
 );
 CREATE TABLE IF NOT EXISTS task_artifacts (
  id TEXT PRIMARY KEY,task_id TEXT NOT NULL,folder_id TEXT REFERENCES artifact_folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL,render_mode TEXT,view_mode TEXT,language TEXT,readability_override TEXT,width_override TEXT,
  zoom_pct INTEGER,html_theme_override TEXT,"order" INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  current_version_id TEXT REFERENCES artifact_versions(id) ON DELETE SET NULL
 );
 CREATE TABLE IF NOT EXISTS artifact_versions (
  id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES task_artifacts(id) ON DELETE CASCADE,
  version_num INTEGER NOT NULL,content_hash TEXT NOT NULL,size INTEGER NOT NULL,name TEXT,author_type TEXT,author_id TEXT,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),parent_id TEXT REFERENCES artifact_versions(id) ON DELETE SET NULL
 );
 CREATE UNIQUE INDEX IF NOT EXISTS artifact_versions_num ON artifact_versions(artifact_id,version_num);
 CREATE UNIQUE INDEX IF NOT EXISTS artifact_versions_name ON artifact_versions(artifact_id,name) WHERE name IS NOT NULL;
 CREATE INDEX IF NOT EXISTS artifact_versions_hash ON artifact_versions(content_hash);
 CREATE INDEX IF NOT EXISTS task_artifacts_task ON task_artifacts(task_id);
 CREATE INDEX IF NOT EXISTS artifact_folders_task ON artifact_folders(task_id);
 CREATE TABLE IF NOT EXISTS artifact_blobs(hash TEXT PRIMARY KEY,size INTEGER NOT NULL);
 `)
  const version = raw.prepare('SELECT version FROM artifact_storage_schema').get() as
    | { version: number }
    | undefined
  if (version && version.version !== 1) throw new Error('Unsupported computer artifact schema')
  if (!version) raw.prepare('INSERT INTO artifact_storage_schema VALUES(1)').run()
  const prepare = (sql: string): PreparedBridge => {
    const statement = raw.prepare(sql)
    return {
      get: async <T>(...params: unknown[]) => statement.get(...params) as T | undefined,
      all: async <T>(...params: unknown[]) => statement.all(...params) as T[],
      run: async (...params) => {
        beforeWrite()
        return statement.run(...params)
      }
    }
  }
  const db: SlayzoneDb = {
    prepare,
    get: async <T>(sql: string, params: unknown[] = []) =>
      raw.prepare(sql).get(...params) as T | undefined,
    all: async <T>(sql: string, params: unknown[] = []) => raw.prepare(sql).all(...params) as T[],
    run: async (sql, params = []) => {
      beforeWrite()
      return raw.prepare(sql).run(...params)
    },
    exec: async (sql) => {
      beforeWrite()
      raw.exec(sql)
    },
    batchTxn: async (ops: BatchOp[]) => {
      beforeWrite()
      return raw
        .transaction(() => ops.map((op) => raw.prepare(op.sql)[op.type](...op.params)))
        .immediate()
    },
    namedTxn: (async (name: string, params: unknown) => {
      const implementation = (
        artifactsTxns as Record<string, (db: Database.Database, p: any) => unknown>
      )[name]
      if (!implementation) throw new Error('Unknown standalone artifact transaction')
      if (
        ![
          'task-artifacts:versions:list',
          'task-artifacts:versions:read',
          'task-artifacts:versions:resolve',
          'task-artifacts:versions:current',
          'task-artifacts:versions:diff',
          'task-artifacts:search'
        ].includes(name)
      )
        beforeWrite()
      return raw.transaction(() => implementation(raw, params)).immediate()
    }) as SlayzoneDb['namedTxn'],
    backup: async (destination) => {
      await raw.backup(destination)
    },
    // The owning chat runtime closes this shared connection.
    close: async () => {}
  }
  return { db, store: createArtifactStore(dataDir) }
}
