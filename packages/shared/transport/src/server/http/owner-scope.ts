/**
 * The REST and MCP half of the owner checks (T-18): what both gates share — reading
 * the ids a request names, deciding them through the ONE access function
 * (`access.ts`), the refusal's audit line — plus the per-request scope the route
 * handlers' own lookups run under.
 *
 * Every decision is `canAccess` / `createAccessScope` (T-16's `mayAccessProject` on the
 * resource's project). What lives here is only how REST ADDRESSES things: the slay CLI
 * names a row by an id PREFIX and a project by id or name substring, so "may the
 * caller use this reference?" becomes "does it match a row in a project the scope
 * allows?" — `accessibleProjectIds()`, never a second rule.
 *
 * @module transport/server/http/owner-scope
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { getSlayzoneHomeDir, getStorageDir, type SlayzoneDb } from '@slayzone/platform'
import { securityEvent } from '@slayzone/platform/security-log'
import { hubStateRoots, type AccessRequest, type AccessScope, type ResourceKind } from '../access'
import type { HttpIdRef } from '../http-owner-policy'

/** The facts `canAccess` needs, for a REST or MCP caller on a hub with login. */
export function httpAccessRequest(userId: string | null): AccessRequest {
  return {
    authRequired: true,
    principal: userId ? { userId } : null,
    // The hub's state dir and its storage (artifact files live under
    // `<storage>/artifacts/<taskId>`, which access.ts gives to that task).
    hubRoots: hubStateRoots([getStorageDir(), getSlayzoneHomeDir()])
  }
}

// ── the per-request scope ─────────────────────────────────────────────────────

/**
 * The scope of the `user` or `admin` request being handled, set by the REST gate
 * around each of the route's handlers (`owner-routes.ts`). `resolve.ts` reads it so an
 * id prefix or a project name only ever matches the caller's own rows. Absent — a hub
 * without login, an `open` route, a caller outside a route — nothing is restricted:
 * the gate has already decided every id such a request names.
 */
const scopeStore = new AsyncLocalStorage<AccessScope>()

export function runInOwnerScope<T>(scope: AccessScope, fn: () => T): T {
  return scopeStore.run(scope, fn)
}

export function currentOwnerScope(): AccessScope | null {
  return scopeStore.getStore() ?? null
}

const projectIdsMemo = new WeakMap<AccessScope, Promise<string[] | null>>()

/** The caller's accessible project ids, once per scope; null = unrestricted. */
export function scopedProjectIds(scope: AccessScope): Promise<string[] | null> {
  let p = projectIdsMemo.get(scope)
  if (!p) {
    p = scope.accessibleProjectIds()
    projectIdsMemo.set(scope, p)
  }
  return p
}

/**
 * How each kind a REST route addresses by prefix reaches its project — the same paths
 * `access.ts` resolves a row by. Keyed by kind, and by the table `resolve.ts` is handed.
 */
const PROJECT_OF: Partial<Record<ResourceKind, { table: string; project: string }>> = {
  project: { table: 'projects', project: 'id' },
  task: { table: 'tasks', project: 'project_id' },
  artifact: {
    table: 'task_artifacts',
    project: '(SELECT t.project_id FROM tasks t WHERE t.id = task_artifacts.task_id)'
  },
  artifactFolder: {
    table: 'artifact_folders',
    project: '(SELECT t.project_id FROM tasks t WHERE t.id = artifact_folders.task_id)'
  },
  tag: { table: 'tags', project: 'project_id' },
  template: { table: 'task_templates', project: 'project_id' },
  automation: { table: 'automations', project: 'project_id' }
}

const KIND_OF_TABLE: Record<string, ResourceKind> = Object.fromEntries(
  Object.entries(PROJECT_OF).map(([kind, v]) => [v!.table, kind as ResourceKind])
)

/** `AND <project expr> IN (…)` for rows of `kind` (or `0` when the caller has none). */
async function projectClause(
  scope: AccessScope,
  projectExpr: string
): Promise<{ sql: string; params: string[] }> {
  const ids = await scopedProjectIds(scope)
  if (ids === null) return { sql: '', params: [] }
  if (ids.length === 0) return { sql: ' AND 0', params: [] }
  return { sql: ` AND ${projectExpr} IN (${ids.map(() => '?').join(', ')})`, params: ids }
}

/**
 * For `resolve.ts`: the clause that keeps a lookup on `table` to the current request's
 * projects. Empty outside a guarded (`user` or `admin`) request on a hub with login,
 * and for a table that holds no user content.
 */
export async function ownedRowsClause(table: string): Promise<{ sql: string; params: string[] }> {
  const scope = currentOwnerScope()
  const kind = KIND_OF_TABLE[table]
  if (!scope || !kind) return { sql: '', params: [] }
  return projectClause(scope, PROJECT_OF[kind]!.project)
}

/** For a list handler's own SQL: `AND <column> IN (caller's projects)`, or nothing. */
export async function ownedProjectsClause(
  column: string
): Promise<{ sql: string; params: string[] }> {
  const scope = currentOwnerScope()
  return scope ? projectClause(scope, column) : { sql: '', params: [] }
}

/** The current request's project ids for a domain call that takes them; null = all. */
export async function ownedProjectIdsOrAll(): Promise<string[] | null> {
  const scope = currentOwnerScope()
  return scope ? scopedProjectIds(scope) : null
}

// ── deciding the ids a request names ──────────────────────────────────────────

/** Every value at `at` in `raw`, and whether one is not an id at all. */
export function idValuesAt(
  raw: unknown,
  at: string,
  except: readonly string[] = []
): { values: string[]; invalid: boolean } {
  const values: string[] = []
  let invalid = false
  const leaf = (v: unknown): void => {
    if (v === null || v === undefined) return
    if (typeof v === 'string') {
      if (v && !except.includes(v)) values.push(v)
      return
    }
    // A number, object or nested array where an id goes: a handler would hand it to
    // its lookup as is, so it is refused rather than guessed at.
    invalid = true
  }
  const walk = (node: unknown, segs: string[]): void => {
    if (node === null || node === undefined) return
    if (segs.length === 0) {
      if (Array.isArray(node)) for (const item of node) leaf(item)
      else leaf(node)
      return
    }
    const [seg, ...rest] = segs
    if (seg === '[]') {
      if (!Array.isArray(node)) {
        if (rest.length === 0) leaf(node)
        return
      }
      for (const item of node) {
        if (rest.length === 0) leaf(item)
        else walk(item, rest)
      }
      return
    }
    if (typeof node === 'object' && !Array.isArray(node)) {
      walk((node as Record<string, unknown>)[seg!], rest)
    }
  }
  const segs = at
    .split('.')
    .flatMap((s) => (s.endsWith('[]') ? [s.slice(0, -2), '[]'] : [s]))
    .filter((s) => s !== '')
  walk(raw, segs)
  return { values, invalid }
}

/** Whether the caller may use `value` the way the route reads it. */
export async function refAllowed(
  db: SlayzoneDb,
  scope: AccessScope,
  ref: HttpIdRef,
  value: string
): Promise<boolean> {
  if (ref.match === 'exact') return scope.allows({ kind: ref.kind, id: value })
  const source = ref.match === 'projectRef' ? PROJECT_OF.project : PROJECT_OF[ref.kind]
  if (!source) return scope.allows({ kind: ref.kind, id: value })
  const clause = await projectClause(scope, source.project)
  const match =
    ref.match === 'projectRef'
      ? { sql: '(id = ? OR LOWER(name) LIKE ?)', params: [value, `%${value.toLowerCase()}%`] }
      : { sql: `id LIKE ? || '%'`, params: [value] }
  const row = await db.get(
    `SELECT 1 FROM ${source.table} WHERE ${match.sql}${clause.sql} LIMIT 1`,
    [...match.params, ...clause.params]
  )
  return !!row
}

export interface DeniedRef {
  readonly ref: HttpIdRef
  /** The refused value; absent when the value was not an id at all. */
  readonly value?: string
}

/** The first id the request names that the caller may not use, or null. */
export async function firstDeniedRef(
  db: SlayzoneDb,
  scope: AccessScope,
  refs: readonly HttpIdRef[],
  raw: unknown
): Promise<DeniedRef | null> {
  for (const ref of refs) {
    const { values, invalid } = idValuesAt(raw, ref.at, ref.except)
    if (invalid) return { ref }
    for (const value of values) {
      if (!(await refAllowed(db, scope, ref, value))) return { ref, value }
    }
  }
  return null
}

/**
 * The one audit line of an owner refusal (`authz.denied`, like T-15's and T-17's).
 * A path can carry a user's directory names: its kind is recorded, never the path.
 */
export function auditOwnerDenied(opts: {
  target: string
  reason: 'not_owner' | 'owner_unclassified' | 'no_principal'
  actor?: string | null
  ip?: string | null
  route?: string | null
  denied?: DeniedRef
  status?: number
}): void {
  const { denied } = opts
  securityEvent({
    event: 'authz.denied',
    outcome: 'denied',
    ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
    ...(opts.ip !== undefined ? { ip: opts.ip } : {}),
    ...(opts.route !== undefined ? { route: opts.route } : {}),
    targetKind: 'procedure',
    targetId: opts.target,
    detail: {
      reason: opts.reason,
      ...(denied ? { resource: denied.ref.kind, at: denied.ref.at } : {}),
      ...(denied?.value && denied.ref.kind !== 'path' ? { resourceId: denied.value } : {}),
      ...(opts.status ? { status: opts.status } : {})
    }
  })
}
