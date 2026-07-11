import type { SlayzoneDb } from '@slayzone/platform'

/**
 * Shared id-prefix / project-reference resolution for the CLI-parity REST
 * routes. Mirrors the slay CLI's resolver semantics exactly
 * (packages/apps/cli/src/db-helpers.mts + commands/tasks/_shared.ts):
 *
 * - entities are addressed by full id OR unique id prefix
 *   (`id LIKE :prefix || '%' LIMIT 2`) — 0 matches → 404, 2+ → 400 ambiguous
 * - projects are addressed by exact id OR case-insensitive name substring
 *   (`id = :ref OR LOWER(name) LIKE '%ref%' LIMIT 10`) — same 404/400 mapping
 *
 * Failures are returned as `{ status, error }` values (not thrown) so routes
 * translate them 1:1 into HTTP responses.
 */

export type ResolveFailure = { status: 404 | 400; error: string }
export type Resolved<T> = { row: T } | ResolveFailure

export function isResolveFailure<T>(r: Resolved<T>): r is ResolveFailure {
  return !('row' in r)
}

/** Resolve one row by id prefix. `table`/`columns`/`entity` are call-site literals. */
export async function resolveByIdPrefix<T extends { id: string }>(
  db: SlayzoneDb,
  table: string,
  prefix: string,
  entity: string,
  columns = '*'
): Promise<Resolved<T>> {
  const rows = await db.all<T>(`SELECT ${columns} FROM ${table} WHERE id LIKE ? || '%' LIMIT 2`, [
    prefix
  ])
  if (rows.length === 0) return { status: 404, error: `${entity} not found: ${prefix}` }
  if (rows.length > 1) {
    return {
      status: 400,
      error: `Ambiguous id prefix "${prefix}". Matches: ${rows.map((r) => r.id.slice(0, 8)).join(', ')}`
    }
  }
  return { row: rows[0] }
}

export interface ResolvedProject {
  id: string
  name: string
  path: string | null
}

/** Resolve a project by exact id or case-insensitive name substring (CLI `resolveProject`). */
export async function resolveProjectRef(
  db: SlayzoneDb,
  ref: string
): Promise<Resolved<ResolvedProject>> {
  const rows = await db.all<ResolvedProject & { id: string }>(
    `SELECT id, name, path FROM projects WHERE id = ? OR LOWER(name) LIKE ? LIMIT 10`,
    [ref, `%${ref.toLowerCase()}%`]
  )
  if (rows.length === 0) return { status: 404, error: `No project matching "${ref}"` }
  if (rows.length > 1) {
    return {
      status: 400,
      error: `Ambiguous project "${ref}". Matches: ${rows.map((p) => p.name).join(', ')}`
    }
  }
  return { row: rows[0] }
}

/** First value of an Express query param (string | string[] | undefined → string | undefined). */
export function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}
