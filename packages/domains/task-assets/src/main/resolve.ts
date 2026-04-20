import type { DbLike } from './db'
import { VersionError } from './errors'
import { parseRow, parseRows } from './parse'
import type { AssetId, AssetVersion, VersionRef } from '../shared/types'

export function getLatestVersion(db: DbLike, assetId: AssetId | string): AssetVersion | null {
  const row = db
    .prepare(
      'SELECT * FROM asset_versions WHERE asset_id = ? ORDER BY version_num DESC LIMIT 1'
    )
    .get(assetId)
  return parseRow(row)
}

/**
 * Current (HEAD) version — the one the app treats as active.
 * Read from `task_assets.current_version_id`. Falls back to latest if
 * the pointer is unset (pre-v112 data paths, or freshly created assets
 * mid-transaction before the pointer gets written).
 */
export function getCurrentVersion(db: DbLike, assetId: AssetId | string): AssetVersion | null {
  const row = db
    .prepare(
      `SELECT v.* FROM asset_versions v
       JOIN task_assets a ON a.current_version_id = v.id
       WHERE a.id = ?`
    )
    .get(assetId)
  const current = parseRow(row)
  if (current) return current
  return getLatestVersion(db, assetId)
}

export function hasChildren(db: DbLike, versionId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM asset_versions WHERE parent_id = ? LIMIT 1')
    .get(versionId) as { 1: number } | undefined
  return !!row
}

/** Immutable if version has children (became a parent) or is named. */
export function isLocked(db: DbLike, version: AssetVersion): boolean {
  if (version.name !== null) return true
  return hasChildren(db, version.id)
}

export function getByVersionNum(
  db: DbLike,
  assetId: AssetId | string,
  versionNum: number
): AssetVersion | null {
  const row = db
    .prepare('SELECT * FROM asset_versions WHERE asset_id = ? AND version_num = ?')
    .get(assetId, versionNum)
  return parseRow(row)
}

export function listVersions(
  db: DbLike,
  assetId: AssetId | string,
  opts: { limit?: number; offset?: number } = {}
): AssetVersion[] {
  const limit = opts.limit ?? 1000
  const offset = opts.offset ?? 0
  const rows = db
    .prepare(
      'SELECT * FROM asset_versions WHERE asset_id = ? ORDER BY version_num DESC LIMIT ? OFFSET ?'
    )
    .all(assetId, limit, offset)
  return parseRows(rows)
}

const HEAD_TILDE_RE = /^head~(\d+)$/i
const HEX_RE = /^[0-9a-f]{4,64}$/i
const INT_RE = /^-?\d+$/

/**
 * Resolves any user-facing reference to a single version row.
 *
 * Supported forms:
 *   - positive int     `3`           absolute version_num
 *   - zero / negative  `0`, `-2`     `0` = latest, `-N` = N steps back
 *   - HEAD             `HEAD`        latest
 *   - HEAD~N           `HEAD~2`      N steps back from latest
 *   - name             `pre-launch`  named version (case-sensitive)
 *   - hash prefix      `a1b2c3d4`    >=4 hex chars; ambiguous → throws
 *
 * Throws `VersionError('NOT_FOUND' | 'AMBIGUOUS_REF' | 'INVALID_REF')`.
 */
export function resolveVersionRef(
  db: DbLike,
  assetId: AssetId | string,
  ref: VersionRef
): AssetVersion {
  const result = tryResolveVersionRef(db, assetId, ref)
  if (!result) {
    throw new VersionError('NOT_FOUND', `Version not found: ${String(ref)}`, { ref })
  }
  return result
}

export function tryResolveVersionRef(
  db: DbLike,
  assetId: AssetId | string,
  ref: VersionRef
): AssetVersion | null {
  if (typeof ref === 'number') {
    if (!Number.isInteger(ref)) {
      throw new VersionError('INVALID_REF', `Non-integer ref: ${ref}`, { ref })
    }
    if (ref <= 0) {
      return resolveRelative(db, assetId, Math.abs(ref))
    }
    return getByVersionNum(db, assetId, ref)
  }

  const trimmed = ref.trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'head' || trimmed.toLowerCase() === 'latest') {
    return getLatestVersion(db, assetId)
  }

  if (INT_RE.test(trimmed)) {
    const n = parseInt(trimmed, 10)
    if (n <= 0) return resolveRelative(db, assetId, Math.abs(n))
    return getByVersionNum(db, assetId, n)
  }

  const headMatch = HEAD_TILDE_RE.exec(trimmed)
  if (headMatch) {
    return resolveRelative(db, assetId, parseInt(headMatch[1], 10))
  }

  // Try name first (exact match, takes priority over hash prefix).
  const byName = db
    .prepare('SELECT * FROM asset_versions WHERE asset_id = ? AND name = ?')
    .get(assetId, trimmed)
  if (byName) return parseRow(byName)

  // Then hash prefix. Ambiguous matches are an error, not a silent pick.
  if (HEX_RE.test(trimmed)) {
    const matches = db
      .prepare(
        'SELECT * FROM asset_versions WHERE asset_id = ? AND content_hash LIKE ? ORDER BY version_num DESC LIMIT 2'
      )
      .all(assetId, `${trimmed.toLowerCase()}%`)
    if (matches.length === 0) return null
    if (matches.length > 1) {
      throw new VersionError(
        'AMBIGUOUS_REF',
        `Hash prefix "${trimmed}" matches multiple versions; provide more characters`,
        { ref: trimmed, matchCount: matches.length }
      )
    }
    return parseRow(matches[0])
  }

  return null
}

function resolveRelative(
  db: DbLike,
  assetId: AssetId | string,
  stepsBack: number
): AssetVersion | null {
  const latest = getLatestVersion(db, assetId)
  if (!latest) return null
  if (stepsBack === 0) return latest
  const row = db
    .prepare(
      `SELECT * FROM asset_versions
       WHERE asset_id = ? AND version_num < ?
       ORDER BY version_num DESC LIMIT 1 OFFSET ?`
    )
    .get(assetId, latest.version_num, stepsBack - 1)
  return parseRow(row)
}

const RESERVED = new Set(['head', 'latest'])

export function isReservedName(name: string): boolean {
  if (!name) return true
  if (RESERVED.has(name.toLowerCase())) return true
  if (HEAD_TILDE_RE.test(name)) return true
  if (INT_RE.test(name)) return true
  return false
}
