import { randomUUID } from 'node:crypto'
import { BlobStore } from './blob-store'
import type { DbLike, TxnRunner } from './db'
import { VersionError } from './errors'
import { parseRow } from './parse'
import { getCurrentVersion, isLocked, isReservedName, resolveVersionRef } from './resolve'
import type { AssetId, AssetVersion, AuthorContext, VersionId, VersionRef } from '../shared/types'

export interface CreateVersionArgs {
  assetId: AssetId | string
  bytes: Buffer | string
  author?: AuthorContext
  /** Optional label. If set, forces row creation even when content matches latest. */
  name?: string | null
  /** Force row creation even when content matches latest. Implicit when `name` is set. */
  honorUnchanged?: boolean
}

function nextVersionNum(db: DbLike, assetId: AssetId | string): number {
  const row = db
    .prepare('SELECT MAX(version_num) AS m FROM asset_versions WHERE asset_id = ?')
    .get(assetId) as { m: number | null }
  return (row.m ?? 0) + 1
}

function insertBlobRow(db: DbLike, hash: string, size: number): void {
  db.prepare('INSERT OR IGNORE INTO asset_blobs (hash, size) VALUES (?, ?)').run(hash, size)
}

function selectVersionById(db: DbLike, id: string): AssetVersion {
  const row = db.prepare('SELECT * FROM asset_versions WHERE id = ?').get(id)
  const parsed = parseRow(row)
  if (!parsed) throw new VersionError('NOT_FOUND', `Version row vanished after insert: ${id}`, { id })
  return parsed
}

function checkNameAvailable(db: DbLike, assetId: AssetId | string, name: string, ignoreId?: string): void {
  if (isReservedName(name)) {
    throw new VersionError('NAME_RESERVED', `Name "${name}" is reserved`, { name })
  }
  const sql = ignoreId
    ? 'SELECT id FROM asset_versions WHERE asset_id = ? AND name = ? AND id != ?'
    : 'SELECT id FROM asset_versions WHERE asset_id = ? AND name = ?'
  const existing = ignoreId
    ? db.prepare(sql).get(assetId, name, ignoreId)
    : db.prepare(sql).get(assetId, name)
  if (existing) {
    throw new VersionError('NAME_TAKEN', `Name "${name}" already used on another version`, {
      name,
    })
  }
}

function setCurrentVersionRow(db: DbLike, assetId: AssetId | string, versionId: string | null): void {
  db.prepare('UPDATE task_assets SET current_version_id = ? WHERE id = ?').run(versionId, assetId)
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
): AssetVersion {
  if (args.name) checkNameAvailable(db, args.assetId, args.name)
  const current = getCurrentVersion(db, args.assetId)
  const blob = blobStore.write(args.bytes)
  const dedup = !args.honorUnchanged && !args.name
  if (dedup && current && current.content_hash === blob.hash) {
    return current
  }
  insertBlobRow(db, blob.hash, blob.size)
  const id = randomUUID() as VersionId
  db.prepare(
    `INSERT INTO asset_versions
     (id, asset_id, version_num, content_hash, size, name, author_type, author_id, parent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    args.assetId,
    nextVersionNum(db, args.assetId),
    blob.hash,
    blob.size,
    args.name ?? null,
    args.author?.type ?? null,
    args.author?.id ?? null,
    current?.id ?? null
  )
  setCurrentVersionRow(db, args.assetId, id)
  return selectVersionById(db, id)
}

/**
 * Append a new version as child of the current (HEAD) version.
 *
 * - Default: dedupes if content matches the current version (returns that
 *   row, no new INSERT). Idempotent for repeated identical writes.
 * - With `name`: always creates a row (names mark intent). Name must be
 *   unique per asset, not reserved.
 * - With `honorUnchanged: true`: always creates a row even w/o name.
 *
 * On insert, `parent_id` is set to the prior current, and the asset's
 * current pointer advances to the new row.
 */
export function createVersion(
  db: DbLike,
  txn: TxnRunner,
  blobStore: BlobStore,
  args: CreateVersionArgs
): AssetVersion {
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
): AssetVersion {
  return txn(() => {
    const current = getCurrentVersion(db, args.assetId)
    if (!current || isLocked(db, current)) {
      return insertNewVersion(db, blobStore, args)
    }
    const blob = blobStore.write(args.bytes)
    if (current.content_hash === blob.hash) return current
    insertBlobRow(db, blob.hash, blob.size)
    db.prepare('UPDATE asset_versions SET content_hash = ?, size = ? WHERE id = ?').run(
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
 * Switch the asset's current pointer to the given version.
 * Next UI save will either mutate current in place (if it's still the
 * tip and unnamed) or auto-branch (if locked).
 */
export function setCurrentVersion(
  db: DbLike,
  txn: TxnRunner,
  assetId: AssetId | string,
  ref: VersionRef
): AssetVersion {
  return txn(() => {
    const version = resolveVersionRef(db, assetId, ref)
    setCurrentVersionRow(db, assetId, version.id)
    return version
  })
}

export interface MutateVersionArgs {
  assetId: AssetId | string
  ref: VersionRef
  bytes: Buffer | string
  author?: AuthorContext
}

/**
 * CLI escape hatch: mutate a specific version's content in place,
 * bypassing the lock rule. Intended for `slay task asset update
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
): AssetVersion {
  return txn(() => {
    const target = resolveVersionRef(db, args.assetId, args.ref)
    const blob = blobStore.write(args.bytes)
    if (target.content_hash === blob.hash) return target
    insertBlobRow(db, blob.hash, blob.size)
    db.prepare('UPDATE asset_versions SET content_hash = ?, size = ? WHERE id = ?').run(
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
  assetId: AssetId | string,
  ref: VersionRef,
  newName: string | null
): AssetVersion {
  return txn(() => {
    const version = resolveVersionRef(db, assetId, ref)
    if (newName !== null) checkNameAvailable(db, assetId, newName, version.id)
    db.prepare('UPDATE asset_versions SET name = ? WHERE id = ?').run(newName, version.id)
    return selectVersionById(db, version.id)
  })
}

export function readVersionContent(blobStore: BlobStore, version: AssetVersion): Buffer {
  return blobStore.read(version.content_hash)
}
