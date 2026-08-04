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

export interface ResolveByIdPrefixOptions {
  /**
   * Extra SQL predicate ANDed onto the prefix match — a call-site literal, never
   * caller input. Exists because a few CLI resolvers scope the addressable set
   * rather than the whole table (`slay tasks archive` only ever matched
   * `archived_at IS NULL`, so an already-archived task reads as "not found"
   * instead of being silently re-archived).
   */
  where?: string
  /**
   * Noun for the ambiguity message, when the entity is addressed in a role the
   * default "id prefix" wording would misattribute (`--parent <prefix>` reports
   * `Ambiguous parent id prefix`, so the operator knows WHICH argument was
   * ambiguous). Defaults to the plain `id prefix` wording.
   */
  ambiguousLabel?: string
}

/** Resolve one row by id prefix. `table`/`columns`/`entity` are call-site literals. */
export async function resolveByIdPrefix<T extends { id: string }>(
  db: SlayzoneDb,
  table: string,
  prefix: string,
  entity: string,
  columns = '*',
  opts: ResolveByIdPrefixOptions = {}
): Promise<Resolved<T>> {
  const extra = opts.where ? ` AND ${opts.where}` : ''
  const rows = await db.all<T>(
    `SELECT ${columns} FROM ${table} WHERE id LIKE ? || '%'${extra} LIMIT 2`,
    [prefix]
  )
  if (rows.length === 0) return { status: 404, error: `${entity} not found: ${prefix}` }
  if (rows.length > 1) {
    return {
      status: 400,
      error: `Ambiguous ${opts.ambiguousLabel ?? 'id prefix'} "${prefix}". Matches: ${rows.map((r) => r.id.slice(0, 8)).join(', ')}`
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
  if (rows.length === 0) {
    // The CLI's resolver printed the available names on a miss ("Available: A, B")
    // and that hint is most of what makes a typo recoverable. Only read on the
    // failure path, so the happy path stays a single query.
    const all = await db.all<{ name: string }>(`SELECT name FROM projects ORDER BY name`)
    const available = all.length > 0 ? ` Available: ${all.map((p) => p.name).join(', ')}` : ''
    return { status: 404, error: `No project matching "${ref}".${available}` }
  }
  if (rows.length > 1) {
    return {
      status: 400,
      error: `Ambiguous project "${ref}". Matches: ${rows.map((p) => p.name).join(', ')}`
    }
  }
  return { row: rows[0] }
}

export interface ResolvedTemplate {
  id: string
  name: string
}

/**
 * Resolve a task template WITHIN a project by id prefix, then by exact
 * (case-insensitive) name — the CLI's `resolveTaskTemplate` order and messages
 * (cli/src/commands/tasks/_shared.ts).
 *
 * Project-scoped on purpose: template names are only unique per project, so an
 * unscoped lookup would resolve "Bugfix" to another project's template.
 * `resolveByIdPrefix` cannot serve this — its `where` is a call-site literal and
 * the project id here is caller-derived.
 */
export async function resolveTemplateRef(
  db: SlayzoneDb,
  projectId: string,
  ref: string
): Promise<Resolved<ResolvedTemplate>> {
  const byPrefix = await db.all<ResolvedTemplate>(
    `SELECT id, name FROM task_templates WHERE id LIKE ? || '%' AND project_id = ? LIMIT 2`,
    [ref, projectId]
  )
  if (byPrefix.length === 1) return { row: byPrefix[0] }
  if (byPrefix.length > 1) {
    return {
      status: 400,
      error: `Ambiguous template id "${ref}". Matches: ${byPrefix.map((r) => r.id.slice(0, 8)).join(', ')}`
    }
  }

  const byName = await db.all<ResolvedTemplate>(
    `SELECT id, name FROM task_templates WHERE project_id = ? AND LOWER(name) = LOWER(?) LIMIT 2`,
    [projectId, ref]
  )
  if (byName.length === 1) return { row: byName[0] }
  if (byName.length > 1) return { status: 400, error: `Ambiguous template name "${ref}".` }

  return { status: 404, error: `Template not found: "${ref}"` }
}

/** First value of an Express query param (string | string[] | undefined → string | undefined). */
export function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}
