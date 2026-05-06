import type { DbLike } from './db'
import { VersionError } from './errors'
import { parseRow, parseRows } from './parse'
import type { ArtifactId, ArtifactVersion, VersionRef } from '../shared/types'

export function getLatestVersion(db: DbLike, artifactId: ArtifactId | string): ArtifactVersion | null {
  const row = db
    .prepare(
      'SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version_num DESC LIMIT 1'
    )
    .get(artifactId)
  return parseRow(row)
}

/**
 * Current (HEAD) version — the one the app treats as active.
 * Read from `task_artifacts.current_version_id`. Falls back to latest if
 * the pointer is unset (pre-v112 data paths, or freshly created artifacts
 * mid-transaction before the pointer gets written).
 */
export function getCurrentVersion(db: DbLike, artifactId: ArtifactId | string): ArtifactVersion | null {
  const row = db
    .prepare(
      `SELECT v.* FROM artifact_versions v
       JOIN task_artifacts a ON a.current_version_id = v.id
       WHERE a.id = ?`
    )
    .get(artifactId)
  const current = parseRow(row)
  if (current) return current
  return getLatestVersion(db, artifactId)
}

export function hasChildren(db: DbLike, versionId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM artifact_versions WHERE parent_id = ? LIMIT 1')
    .get(versionId) as { 1: number } | undefined
  return !!row
}

/** Immutable if version has children (became a parent) or is named. */
export function isLocked(db: DbLike, version: ArtifactVersion): boolean {
  if (version.name !== null) return true
  return hasChildren(db, version.id)
}

export function getByVersionNum(
  db: DbLike,
  artifactId: ArtifactId | string,
  versionNum: number
): ArtifactVersion | null {
  const row = db
    .prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND version_num = ?')
    .get(artifactId, versionNum)
  return parseRow(row)
}

export function listVersions(
  db: DbLike,
  artifactId: ArtifactId | string,
  opts: { limit?: number; offset?: number } = {}
): ArtifactVersion[] {
  const limit = opts.limit ?? 1000
  const offset = opts.offset ?? 0
  const rows = db
    .prepare(
      'SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version_num DESC LIMIT ? OFFSET ?'
    )
    .all(artifactId, limit, offset)
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
  artifactId: ArtifactId | string,
  ref: VersionRef
): ArtifactVersion {
  const result = tryResolveVersionRef(db, artifactId, ref)
  if (!result) {
    throw new VersionError('NOT_FOUND', `Version not found: ${String(ref)}`, { ref })
  }
  return result
}

export function tryResolveVersionRef(
  db: DbLike,
  artifactId: ArtifactId | string,
  ref: VersionRef
): ArtifactVersion | null {
  if (typeof ref === 'number') {
    if (!Number.isInteger(ref)) {
      throw new VersionError('INVALID_REF', `Non-integer ref: ${ref}`, { ref })
    }
    if (ref <= 0) {
      return resolveRelative(db, artifactId, Math.abs(ref))
    }
    return getByVersionNum(db, artifactId, ref)
  }

  const trimmed = ref.trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'head' || trimmed.toLowerCase() === 'current') {
    return getCurrentVersion(db, artifactId)
  }
  if (trimmed.toLowerCase() === 'latest') {
    return getLatestVersion(db, artifactId)
  }

  if (INT_RE.test(trimmed)) {
    const n = parseInt(trimmed, 10)
    if (n <= 0) return resolveRelative(db, artifactId, Math.abs(n))
    return getByVersionNum(db, artifactId, n)
  }

  const headMatch = HEAD_TILDE_RE.exec(trimmed)
  if (headMatch) {
    return resolveRelative(db, artifactId, parseInt(headMatch[1], 10))
  }

  // Try name first (exact match, takes priority over hash prefix).
  const byName = db
    .prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND name = ?')
    .get(artifactId, trimmed)
  if (byName) return parseRow(byName)

  // Then hash prefix. Ambiguous matches are an error, not a silent pick.
  if (HEX_RE.test(trimmed)) {
    const matches = db
      .prepare(
        'SELECT * FROM artifact_versions WHERE artifact_id = ? AND content_hash LIKE ? ORDER BY version_num DESC LIMIT 2'
      )
      .all(artifactId, `${trimmed.toLowerCase()}%`)
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
  artifactId: ArtifactId | string,
  stepsBack: number
): ArtifactVersion | null {
  // Walk parent chain from current. Correct in tree mode — HEAD~N is "N
  // steps back along this branch's ancestry", not "N steps back by
  // version_num" (which could jump across branches).
  let cursor = getCurrentVersion(db, artifactId)
  if (!cursor) return null
  for (let i = 0; i < stepsBack; i++) {
    if (!cursor.parent_id) return null
    const row = db.prepare('SELECT * FROM artifact_versions WHERE id = ?').get(cursor.parent_id)
    const parsed = parseRow(row)
    if (!parsed) return null
    cursor = parsed
  }
  return cursor
}

const RESERVED = new Set(['head', 'latest', 'current'])

export function isReservedName(name: string): boolean {
  if (!name) return true
  if (RESERVED.has(name.toLowerCase())) return true
  if (HEAD_TILDE_RE.test(name)) return true
  if (INT_RE.test(name)) return true
  return false
}
