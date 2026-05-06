import { randomUUID } from 'node:crypto'
import { BlobStore } from './blob-store'
import type { DbLike, TxnRunner } from './db'
import { VersionError } from './errors'
import { parseRow } from './parse'
import { getCurrentVersion, isLocked, isReservedName, resolveVersionRef } from './resolve'
import type { ArtifactId, ArtifactVersion, AuthorContext, VersionId, VersionRef } from '../shared/types'

export interface CreateVersionArgs {
  artifactId: ArtifactId | string
  bytes: Buffer | string
  author?: AuthorContext
  /** Optional label. If set, forces row creation even when content matches latest. */
  name?: string | null
  /** Force row creation even when content matches latest. Implicit when `name` is set. */
  honorUnchanged?: boolean
}

function nextVersionNum(db: DbLike, artifactId: ArtifactId | string): number {
  const row = db
    .prepare('SELECT MAX(version_num) AS m FROM artifact_versions WHERE artifact_id = ?')
    .get(artifactId) as { m: number | null }
  return (row.m ?? 0) + 1
}

function insertBlobRow(db: DbLike, hash: string, size: number): void {
  db.prepare('INSERT OR IGNORE INTO artifact_blobs (hash, size) VALUES (?, ?)').run(hash, size)
}

function selectVersionById(db: DbLike, id: string): ArtifactVersion {
  const row = db.prepare('SELECT * FROM artifact_versions WHERE id = ?').get(id)
  const parsed = parseRow(row)
  if (!parsed) throw new VersionError('NOT_FOUND', `Version row vanished after insert: ${id}`, { id })
  return parsed
}

function checkNameAvailable(db: DbLike, artifactId: ArtifactId | string, name: string, ignoreId?: string): void {
  if (isReservedName(name)) {
    throw new VersionError('NAME_RESERVED', `Name "${name}" is reserved`, { name })
  }
  const sql = ignoreId
    ? 'SELECT id FROM artifact_versions WHERE artifact_id = ? AND name = ? AND id != ?'
    : 'SELECT id FROM artifact_versions WHERE artifact_id = ? AND name = ?'
  const existing = ignoreId
    ? db.prepare(sql).get(artifactId, name, ignoreId)
    : db.prepare(sql).get(artifactId, name)
  if (existing) {
    throw new VersionError('NAME_TAKEN', `Name "${name}" already used on another version`, {
      name,
    })
  }
}

function setCurrentVersionRow(db: DbLike, artifactId: ArtifactId | string, versionId: string | null): void {
  db.prepare('UPDATE task_artifacts SET current_version_id = ? WHERE id = ?').run(versionId, artifactId)
}

/**
 * Unwrapped insert — callers MUST run inside an open transaction.
 * Keeps `createVersion` and `saveCurrent`'s branch path from nesting
 * transactions (SQLite doesn't support nested BEGIN).
 */
function insertNewVersion(
  db: DbLike,
  blobStore: BlobStore,
  args: CreateVersionArgs
): ArtifactVersion {
  if (args.name) checkNameAvailable(db, args.artifactId, args.name)
  const current = getCurrentVersion(db, args.artifactId)
  const blob = blobStore.write(args.bytes)
  const dedup = !args.honorUnchanged && !args.name
  if (dedup && current && current.content_hash === blob.hash) {
    return current
  }
  insertBlobRow(db, blob.hash, blob.size)
  const id = randomUUID() as VersionId
  db.prepare(
    `INSERT INTO artifact_versions
     (id, artifact_id, version_num, content_hash, size, name, author_type, author_id, parent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    args.artifactId,
    nextVersionNum(db, args.artifactId),
    blob.hash,
    blob.size,
    args.name ?? null,
    args.author?.type ?? null,
    args.author?.id ?? null,
    current?.id ?? null
  )
  setCurrentVersionRow(db, args.artifactId, id)
  return selectVersionById(db, id)
}

/**
 * Append a new version as child of the current (HEAD) version.
 *
 * - Default: dedupes if content matches the current version (returns that
 *   row, no new INSERT). Idempotent for repeated identical writes.
 * - With `name`: always creates a row (names mark intent). Name must be
 *   unique per artifact, not reserved.
 * - With `honorUnchanged: true`: always creates a row even w/o name.
 *
 * On insert, `parent_id` is set to the prior current, and the artifact's
 * current pointer advances to the new row.
 */
export function createVersion(
  db: DbLike,
  txn: TxnRunner,
  blobStore: BlobStore,
  args: CreateVersionArgs
): ArtifactVersion {
  return txn(() => insertNewVersion(db, blobStore, args))
}

/**
 * Save content to the current version.
 *
 * - Current is **mutable** (tip + unnamed) → update in place. Matches
 *   legacy autosave behavior for linear history.
 * - Current is **locked** (has children OR is named) → create a new
 *   version as child of current and advance the current pointer.
 *   This is the auto-branch path users hit after switching current to
 *   an older version.
 * - No versions yet → create v1 as root.
 *
 * Named versions are never mutated in place via this function — use
 * `mutateVersion` (CLI escape hatch) for that.
 */
export function saveCurrent(
  db: DbLike,
  txn: TxnRunner,
  blobStore: BlobStore,
  args: CreateVersionArgs
): ArtifactVersion {
  return txn(() => {
    const current = getCurrentVersion(db, args.artifactId)
    if (!current || isLocked(db, current)) {
      return insertNewVersion(db, blobStore, args)
    }
    const blob = blobStore.write(args.bytes)
    if (current.content_hash === blob.hash) return current
    insertBlobRow(db, blob.hash, blob.size)
    db.prepare('UPDATE artifact_versions SET content_hash = ?, size = ? WHERE id = ?').run(
      blob.hash,
      blob.size,
      current.id
    )
    return selectVersionById(db, current.id)
  })
}

/** Back-compat alias. Callers should migrate to `saveCurrent`. */
export const mutateLatestVersion = saveCurrent

/**
 * Switch the artifact's current pointer to the given version.
 * Next UI save will either mutate current in place (if it's still the
 * tip and unnamed) or auto-branch (if locked).
 */
export function setCurrentVersion(
  db: DbLike,
  txn: TxnRunner,
  artifactId: ArtifactId | string,
  ref: VersionRef
): ArtifactVersion {
  return txn(() => {
    const version = resolveVersionRef(db, artifactId, ref)
    setCurrentVersionRow(db, artifactId, version.id)
    return version
  })
}

export interface MutateVersionArgs {
  artifactId: ArtifactId | string
  ref: VersionRef
  bytes: Buffer | string
  author?: AuthorContext
}

/**
 * CLI escape hatch: mutate a specific version's content in place,
 * bypassing the lock rule. Intended for `slay task artifact update
 * --mutate-version <ref>`. Not exposed in the renderer.
 *
 * Refuses to mutate if the new content would produce a hash collision
 * with an existing sibling under the same parent — that would make two
 * children indistinguishable by hash.
 */
export function mutateVersion(
  db: DbLike,
  txn: TxnRunner,
  blobStore: BlobStore,
  args: MutateVersionArgs
): ArtifactVersion {
  return txn(() => {
    const target = resolveVersionRef(db, args.artifactId, args.ref)
    const blob = blobStore.write(args.bytes)
    if (target.content_hash === blob.hash) return target
    insertBlobRow(db, blob.hash, blob.size)
    db.prepare('UPDATE artifact_versions SET content_hash = ?, size = ? WHERE id = ?').run(
      blob.hash,
      blob.size,
      target.id
    )
    return selectVersionById(db, target.id)
  })
}

export function renameVersion(
  db: DbLike,
  txn: TxnRunner,
  artifactId: ArtifactId | string,
  ref: VersionRef,
  newName: string | null
): ArtifactVersion {
  return txn(() => {
    const version = resolveVersionRef(db, artifactId, ref)
    if (newName !== null) checkNameAvailable(db, artifactId, newName, version.id)
    db.prepare('UPDATE artifact_versions SET name = ? WHERE id = ?').run(newName, version.id)
    return selectVersionById(db, version.id)
  })
}

export function readVersionContent(blobStore: BlobStore, version: ArtifactVersion): Buffer {
  return blobStore.read(version.content_hash)
}
