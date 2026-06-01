import type { Database } from 'better-sqlite3'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { getExtensionFromTitle } from '@slayzone/task/shared'
import { BlobStore } from './blob-store'
import { betterSqliteTxn, type DbLike } from './db'
import {
  createVersion,
  saveCurrent,
  setCurrentVersion,
  mutateVersion,
  renameVersion,
  readVersionContent
} from './mutations'
import { pruneVersions } from './prune'
import { listVersions, resolveVersionRef } from './resolve'
import { diffVersions } from './diff'
import type {
  ArtifactId,
  ArtifactVersion,
  AuthorContext,
  DiffResult,
  PruneOptions,
  PruneReport,
  SeedReport,
  VersionId,
  VersionRef
} from '../shared/types'

/**
 * Named-transaction adapters for task artifacts. These are the conditional
 * read-modify-write mutations (version branching on a content-hash dedup check,
 * mutable-vs-locked save path, MAX(version_num)+1 inserts, ref resolution then
 * write, cascade prune + orphan-blob GC) that can't be expressed as a static
 * op list — they must run as a single function inside the DB worker so the
 * read and the dependent write stay atomic and race-free.
 *
 * Each entry rebuilds the worker-local collaborators from serializable params:
 *   - `db` is the worker's synchronous better-sqlite3 handle. The existing
 *     domain functions accept the driver-agnostic `DbLike` shape that
 *     better-sqlite3 satisfies, so we pass it straight through.
 *   - `betterSqliteTxn(db)` owns the `db.transaction(...)`; the worker invokes
 *     these directly and does NOT re-wrap them.
 *   - `BlobStore` is reconstructed from `dataDir` (pure node:fs, worker-safe);
 *     it can't be serialized, so the caller sends the data dir instead.
 *
 * Pure: imports only node builtins, better-sqlite3 (type-only), the pure
 * `@slayzone/task/shared` string helper, and this domain's own pure logic — so
 * it is safe to pull into the worker bundle (unlike the React/electron-laden
 * `/main` barrel).
 *
 * Registered into the worker's txn registry via the narrow `@slayzone/task-artifacts/db`
 * entry — never the `/main` barrel.
 */

export interface CreateVersionTxnParams {
  dataDir: string
  artifactId: ArtifactId | string
  bytes: Buffer | string
  author?: AuthorContext
  name?: string | null
  honorUnchanged?: boolean
}

export interface SaveCurrentTxnParams {
  dataDir: string
  artifactId: ArtifactId | string
  bytes: Buffer | string
  author?: AuthorContext
  name?: string | null
  honorUnchanged?: boolean
}

export interface SetCurrentVersionTxnParams {
  artifactId: ArtifactId | string
  ref: VersionRef
}

export interface MutateVersionTxnParams {
  dataDir: string
  artifactId: ArtifactId | string
  ref: VersionRef
  bytes: Buffer | string
  author?: AuthorContext
}

export interface RenameVersionTxnParams {
  artifactId: ArtifactId | string
  ref: VersionRef
  newName: string | null
}

export interface PruneVersionsTxnParams {
  dataDir: string
  artifactId: ArtifactId | string
  opts?: PruneOptions
}

export interface SeedInitialVersionsTxnParams {
  dataDir: string
  /** Directory holding artifact files on disk (`{dataDir}/artifacts`). */
  artifactsDir: string
}

export interface ListVersionsTxnParams {
  artifactId: ArtifactId | string
  limit?: number
  offset?: number
}

export interface ReadVersionContentTxnParams {
  dataDir: string
  artifactId: ArtifactId | string
  ref: VersionRef
}

export interface DiffVersionsTxnParams {
  dataDir: string
  artifactId: ArtifactId | string
  a: VersionRef
  b?: VersionRef
}

/**
 * Worker-side seed. Mirrors `seedInitialVersions` from `seed.ts`, but
 * reconstructs the file-path resolver from `artifactsDir` (a closure can't
 * cross the worker boundary) and drops the `onProgress` callback (the worker
 * can't call back into main). One-time idempotent boot seed.
 */
function seedInitialVersionsInWorker(
  rawDb: Database,
  blobStore: BlobStore,
  artifactsDir: string
): SeedReport {
  const db = asDbLike(rawDb)
  const txn = betterSqliteTxn(rawDb)
  const needsSeed = db
    .prepare(
      `SELECT ta.id, ta.task_id, ta.title
       FROM task_artifacts ta
       LEFT JOIN artifact_versions av ON av.artifact_id = ta.id
       WHERE av.id IS NULL
       GROUP BY ta.id`
    )
    .all() as { id: string; task_id: string; title: string }[]

  let seeded = 0
  let skippedMissing = 0

  const insertVersion = db.prepare(
    `INSERT INTO artifact_versions
     (id, artifact_id, version_num, content_hash, size, name, author_type, author_id, parent_id)
     VALUES (?, ?, 1, ?, ?, NULL, NULL, NULL, NULL)`
  )
  const insertBlob = db.prepare('INSERT OR IGNORE INTO artifact_blobs (hash, size) VALUES (?, ?)')
  const setCurrent = db.prepare('UPDATE task_artifacts SET current_version_id = ? WHERE id = ?')

  for (const row of needsSeed) {
    const ext = getExtensionFromTitle(row.title) || '.txt'
    const filePath = join(artifactsDir, row.task_id, `${row.id}${ext}`)
    if (!existsSync(filePath)) {
      skippedMissing++
      continue
    }
    const buf = readFileSync(filePath)
    txn(() => {
      const blob = blobStore.write(buf)
      insertBlob.run(blob.hash, blob.size)
      const versionId = randomUUID() as VersionId
      insertVersion.run(versionId, row.id, blob.hash, blob.size)
      setCurrent.run(versionId, row.id)
    })
    seeded++
  }

  return { seeded, skippedMissing }
}

/**
 * `db` is the worker's better-sqlite3 handle, which satisfies the
 * driver-agnostic `DbLike` shape the domain functions accept.
 */
function asDbLike(db: Database): DbLike {
  return db as unknown as DbLike
}

export const artifactTxns = {
  'artifacts:create-version': (db: Database, p: CreateVersionTxnParams): ArtifactVersion =>
    createVersion(asDbLike(db), betterSqliteTxn(db), new BlobStore(p.dataDir), {
      artifactId: p.artifactId,
      bytes: p.bytes,
      author: p.author,
      name: p.name,
      honorUnchanged: p.honorUnchanged
    }),

  'artifacts:save-current': (db: Database, p: SaveCurrentTxnParams): ArtifactVersion =>
    saveCurrent(asDbLike(db), betterSqliteTxn(db), new BlobStore(p.dataDir), {
      artifactId: p.artifactId,
      bytes: p.bytes,
      author: p.author,
      name: p.name,
      honorUnchanged: p.honorUnchanged
    }),

  'artifacts:set-current-version': (
    db: Database,
    p: SetCurrentVersionTxnParams
  ): ArtifactVersion =>
    setCurrentVersion(asDbLike(db), betterSqliteTxn(db), p.artifactId, p.ref),

  'artifacts:mutate-version': (db: Database, p: MutateVersionTxnParams): ArtifactVersion =>
    mutateVersion(asDbLike(db), betterSqliteTxn(db), new BlobStore(p.dataDir), {
      artifactId: p.artifactId,
      ref: p.ref,
      bytes: p.bytes,
      author: p.author
    }),

  'artifacts:rename-version': (db: Database, p: RenameVersionTxnParams): ArtifactVersion =>
    renameVersion(asDbLike(db), betterSqliteTxn(db), p.artifactId, p.ref, p.newName),

  'artifacts:prune-versions': (db: Database, p: PruneVersionsTxnParams): PruneReport =>
    pruneVersions(asDbLike(db), betterSqliteTxn(db), new BlobStore(p.dataDir), p.artifactId, p.opts),

  'artifacts:seed-initial-versions': (db: Database, p: SeedInitialVersionsTxnParams): SeedReport =>
    seedInitialVersionsInWorker(db, new BlobStore(p.dataDir), p.artifactsDir),

  // --- Read paths (no write, but multi-statement) ---
  // These resolve refs / walk parent chains / read blobs across several
  // queries. Routing them through the worker keeps that logic atomic and
  // colocated rather than re-implementing it as a chain of awaited queries in
  // the handler. Returns are plain serializable values.
  'artifacts:list-versions': (db: Database, p: ListVersionsTxnParams): ArtifactVersion[] =>
    listVersions(asDbLike(db), p.artifactId, { limit: p.limit, offset: p.offset }),

  'artifacts:read-version-content': (db: Database, p: ReadVersionContentTxnParams): string => {
    const version = resolveVersionRef(asDbLike(db), p.artifactId, p.ref)
    return readVersionContent(new BlobStore(p.dataDir), version).toString('utf-8')
  },

  'artifacts:diff-versions': (db: Database, p: DiffVersionsTxnParams): DiffResult =>
    diffVersions(asDbLike(db), new BlobStore(p.dataDir), {
      artifactId: p.artifactId,
      a: p.a,
      b: p.b
    })
} satisfies Record<string, (db: Database, params: never) => unknown>
