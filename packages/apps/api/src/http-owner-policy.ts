/**
 * Which user content each `user` and `admin` REST route and MCP tool touches, and how
 * the owner gates keep it to its owner on a hub that requires login (T-18) — the
 * `/api/*` and `/mcp` twin of `owner-policy.ts` (tRPC, T-17). `admin` items are owner
 * questions too (T-106): the role decides who may manage, never whose content. Same
 * marks, same decision:
 *
 *   id-checked      the request names user content (`ids`). Every id must pass the
 *                   access function (`access.ts` `canAccess`) before the handler runs;
 *                   one that does not — someone else's, missing, or ownerless —
 *                   answers 404 with one `authz.denied` line. Some also cut their
 *                   result (`output`).
 *   list-filtered   the result is cut to what the caller may access (`output`), and/or
 *                   the handler scopes its query to the caller's projects
 *                   (`scopedInHandler`) where a LIMIT or an aggregate makes cutting
 *                   after the fact wrong.
 *   no-owned-input  names nothing a user owns (`why` says what it touches instead).
 *
 * Keyed exactly like T-15's `REST_ADMIN_POLICY` (`METHOD /path` as registered) and
 * `MCP_ADMIN_POLICY` (tool name); `http-owner-policy.test.ts` cross-checks both maps
 * against the LIVE registrations, so an unmarked new route or tool fails there by
 * name — and is refused at runtime on a hub with login (fail closed).
 *
 * THE DECISION is never made here: an entry only says WHERE the ids are and how the
 * route reads them. Whether an id is accessible is `canAccess` — so sharing (T-100)
 * changes no entry.
 *
 * Inert without login: on the desktop app's hub (`SLAYZONE_HUB_REQUIRE_LOGIN=0`) the
 * gates return before reading these maps.
 *
 * @module api/http-owner-policy
 */
import type { AccessScope, OwnedResource, ResourceKind } from './access'
import type { OwnerMark } from './owner-policy'

/**
 * How a route reads an id it is given:
 *
 *   exact       a full id (`WHERE id = ?`).
 *   prefix      a full id OR a unique id prefix (`resolveByIdPrefix`, the slay CLI's
 *               addressing). The gate admits it when a row the caller may access
 *               matches; the route's own resolver then only ever sees the caller's
 *               rows (`resolve.ts`), so a prefix shared with someone else's row is
 *               neither ambiguous nor theirs.
 *   projectRef  a project's id OR a case-insensitive name substring
 *               (`resolveProjectRef`); same rule.
 */
export type HttpIdMatch = 'exact' | 'prefix' | 'projectRef'

/**
 * Where an id sits. REST: `params.<name>`, `query.<name>` or `body.<path>` (dotted;
 * `x[]` an array). MCP: the tool argument's path. An absent or null value is skipped
 * (the handler decides whether it is required); an array where one id is expected is
 * checked element by element; any other non-string value is refused.
 */
export interface HttpIdRef {
  readonly at: string
  readonly kind: ResourceKind
  readonly match: HttpIdMatch
  /** Literal values that are not ids (a folder field's `'root'`). */
  readonly except?: readonly string[]
}

/** The gate refuses the whole response (404 + audit) when an output filter returns this. */
export const DENY_RESPONSE: unique symbol = Symbol('http-owner-policy.deny')

/** Rewrites a JSON response body to what the scope allows (or {@link DENY_RESPONSE}). */
export type HttpOutputFilter = (body: unknown, scope: AccessScope) => Promise<unknown>

export interface HttpOwnerRule {
  readonly mark: OwnerMark
  readonly ids?: readonly HttpIdRef[]
  /** Cut the JSON body the handler sends (`res.json`). */
  readonly output?: HttpOutputFilter
  /** The handler scopes its own query to the caller's projects; says how. */
  readonly scopedInHandler?: string
  /** The ids are checked inside the handler, not by the gate; says how. */
  readonly checkedInHandler?: string
  readonly why?: string
}

// ── building blocks ───────────────────────────────────────────────────────────

const ref =
  (kind: ResourceKind, match: HttpIdMatch) =>
  (at: string, except?: readonly string[]): HttpIdRef => ({
    at,
    kind,
    match,
    ...(except ? { except } : {})
  })
const task = ref('task', 'exact')
const taskPrefix = ref('task', 'prefix')
const projectExact = ref('project', 'exact')
const projectRef = ref('project', 'projectRef')
const artifact = ref('artifact', 'exact')
const artifactPrefix = ref('artifact', 'prefix')
const folderPrefix = ref('artifactFolder', 'prefix')
const tagPrefix = ref('tag', 'prefix')
const template = ref('template', 'exact')
const templatePrefix = ref('template', 'prefix')
const session = ref('session', 'exact')
const tab = ref('tab', 'exact')
const proc = ref('process', 'exact')
const path = ref('path', 'exact')
const computer = ref('computer', 'exact')
const automation = ref('automation', 'exact')
const automationPrefix = ref('automation', 'prefix')

const checked = (...ids: HttpIdRef[]): HttpOwnerRule => ({ mark: 'id-checked', ids })
const listed = (output: HttpOutputFilter, scopedInHandler?: string): HttpOwnerRule => ({
  mark: 'list-filtered',
  output,
  ...(scopedInHandler ? { scopedInHandler } : {})
})
const none = (why: string): HttpOwnerRule => ({ mark: 'no-owned-input', why })
const then = (rule: HttpOwnerRule, output: HttpOutputFilter): HttpOwnerRule => ({
  ...rule,
  output
})

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const res = (kind: ResourceKind, id: unknown): OwnedResource | null =>
  typeof id === 'string' && id ? { kind, id } : null

// ── output filters ────────────────────────────────────────────────────────────

/** Rows naming their resource in `field`; a row with none has no owner path: dropped. */
async function keepRows(
  rows: readonly unknown[],
  toResource: (row: Record<string, unknown>) => OwnedResource | null,
  scope: AccessScope
): Promise<unknown[]> {
  const out: unknown[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const r = toResource(row)
    if (r && (await scope.allows(r))) out.push(row)
  }
  return out
}

const byField =
  (field: string, kind: ResourceKind) =>
  (row: Record<string, unknown>): OwnedResource | null =>
    res(kind, row[field])

/** A bare JSON array (`/api/pty`, `/api/processes`). */
const bareRows =
  (toResource: (row: Record<string, unknown>) => OwnedResource | null): HttpOutputFilter =>
  async (body, scope) =>
    Array.isArray(body) ? keepRows(body, toResource, scope) : body

/** `{ ok, data: [...] }`. */
const dataRows =
  (field: string, kind: ResourceKind): HttpOutputFilter =>
  async (body, scope) =>
    isRecord(body) && Array.isArray(body.data)
      ? { ...body, data: await keepRows(body.data, byField(field, kind), scope) }
      : body

/** `{ ok, data: { <list>: [...] } }`: each named list inside `data` is cut. */
const nestedRows =
  (lists: readonly string[], field: string, kind: ResourceKind): HttpOutputFilter =>
  async (body, scope) => {
    if (!isRecord(body) || !isRecord(body.data)) return body
    const data: Record<string, unknown> = { ...body.data }
    for (const key of lists) {
      if (Array.isArray(data[key]))
        data[key] = await keepRows(data[key], byField(field, kind), scope)
    }
    return { ...body, data }
  }

/** `{ ok, data: { <field>: id } }` — one resource: refused outright when not the caller's. */
const dataOne =
  (field: string, kind: ResourceKind): HttpOutputFilter =>
  async (body, scope) => {
    if (!isRecord(body) || !isRecord(body.data)) return body
    const r = res(kind, body.data[field])
    return r && (await scope.allows(r)) ? body : DENY_RESPONSE
  }

/** A process row: its task when set, else its project (`processes.list`, T-17). */
const processRow = (row: Record<string, unknown>): OwnedResource | null =>
  res('task', row.taskId) ?? res('project', row.projectId)

// ── reasons for `no-owned-input` ──────────────────────────────────────────────

const SELF =
  "the caller's own panel settings (per-user since T-16: SettingsService.forUser(principal))"
const SIGNAL =
  "a refresh ping: carries no content, and is attributed to the caller (the security context the gate re-enters) so T-17's stream filter delivers it to the caller only"
const DEEP_LINK =
  "the desktop app's own OAuth deep-link callback (app.auth.onCallback, a desktop-host event): names nothing a user owns"
const COMPUTER =
  "the computer roster: cut in the handler to the caller's own, or every one for an admin (management metadata; computer-access.ts, T-19)"
const ACCOUNTS =
  'hub accounts (email, name, role, disabled): what the admin manages; no project content'

// ── REST ──────────────────────────────────────────────────────────────────────

const taskRowsById = dataRows('id', 'task')

export const REST_OWNER_POLICY: Record<string, HttpOwnerRule> = {
  // ── agent hooks ──
  'POST /api/agent-hook': {
    mark: 'id-checked',
    checkedInHandler:
      'processAgentHook resolves the envelope to its task / slay session and drops (with an audit line) any event the reporting principal may not access (agent-hook-owner.ts)'
  },

  // ── artifacts ──
  'POST /api/artifact-folders': checked(taskPrefix('body.taskId'), folderPrefix('body.parentId')),
  'DELETE /api/artifact-folders/:id': checked(folderPrefix('params.id')),
  'PATCH /api/artifact-folders/:id': checked(
    folderPrefix('params.id'),
    folderPrefix('body.parentId', ['root'])
  ),
  // JSON body, or raw bytes with the refs in the query string (createArtifactFromStream).
  'POST /api/artifacts': checked(
    taskPrefix('body.taskId'),
    folderPrefix('body.folderId'),
    taskPrefix('query.taskId'),
    folderPrefix('query.folderId', ['root'])
  ),
  'DELETE /api/artifacts/:id': checked(artifactPrefix('params.id')),
  'GET /api/artifacts/:id': checked(artifactPrefix('params.id')),
  'PATCH /api/artifacts/:id': checked(
    artifactPrefix('params.id'),
    folderPrefix('body.folderId', ['root'])
  ),
  'GET /api/artifacts/:id/content': checked(artifactPrefix('params.id')),
  'POST /api/artifacts/:id/content': checked(artifactPrefix('params.id')),
  'PUT /api/artifacts/:id/content': checked(artifactPrefix('params.id')),
  // `outputPath` is a hub-host path the render is WRITTEN to: someone else's worktree
  // or artifact directory, or the hub's own state directory, is refused (access.ts `path`).
  'POST /api/artifacts/:id/export/html': checked(artifact('params.id'), path('body.outputPath')),
  'POST /api/artifacts/:id/export/pdf': checked(artifact('params.id'), path('body.outputPath')),
  'POST /api/artifacts/:id/export/png': checked(artifact('params.id'), path('body.outputPath')),
  'GET /api/artifacts/:id/versions': checked(artifactPrefix('params.id')),
  'PATCH /api/artifacts/:id/versions': checked(artifactPrefix('params.id')),
  'POST /api/artifacts/:id/versions': checked(artifactPrefix('params.id')),
  'GET /api/artifacts/:id/versions/content': checked(artifactPrefix('params.id')),
  'GET /api/artifacts/:id/versions/current': checked(artifactPrefix('params.id')),
  'POST /api/artifacts/:id/versions/current': checked(artifactPrefix('params.id')),
  'GET /api/artifacts/:id/versions/diff': checked(artifactPrefix('params.id')),
  'POST /api/artifacts/:id/versions/prune': checked(artifactPrefix('params.id')),
  'GET /api/artifacts/search': {
    ...checked(taskPrefix('query.taskId'), folderPrefix('query.folderId', ['root'])),
    scopedInHandler:
      '`allTasks` scans only the caller’s projects (searchArtifacts `projectIds`), so neither the results, the scanned count nor the skipped-large titles name anyone else’s'
  },
  'POST /api/open-artifact/:id': checked(artifact('params.id')),
  'GET /api/tasks/:id/artifacts': checked(taskPrefix('params.id')),
  'POST /api/tasks/:id/artifacts': checked(taskPrefix('params.id')),

  // ── auth ──
  'POST /api/auth/deep-link': none(DEEP_LINK),

  // ── browser panel (keyed by the task whose panel it is) ──
  'POST /api/browser/click': checked(task('body.taskId')),
  'GET /api/browser/content': checked(task('query.taskId')),
  'POST /api/browser/eval': checked(task('body.taskId')),
  'POST /api/browser/navigate': checked(task('body.taskId')),
  'POST /api/browser/screenshot': checked(task('body.taskId')),
  'GET /api/browser/tabs': checked(task('query.taskId')),
  'POST /api/browser/tabs': checked(task('body.taskId')),
  'POST /api/browser/type': checked(task('body.taskId')),
  'GET /api/browser/url': checked(task('query.taskId')),

  // ── app ──
  'POST /api/close-task/:id': checked(task('params.id')),
  'POST /api/open-task/:id': checked(taskPrefix('params.id')),
  'POST /api/notify': none(SIGNAL),
  'GET /api/computers': none(COMPUTER),

  // ── panels ──
  'GET /api/panels': none(SELF),
  'POST /api/panels': none(SELF),
  'DELETE /api/panels/:idOrName': none(SELF),
  'PATCH /api/panels/:idOrName': none(SELF),

  // ── processes ──
  'GET /api/processes': listed(bareRows(processRow)),
  'DELETE /api/processes/:id': checked(proc('params.id')),
  'GET /api/processes/:id/follow': checked(proc('params.id')),
  'GET /api/processes/:id/logs': checked(proc('params.id')),

  // ── projects ──
  'GET /api/projects': listed(dataRows('id', 'project')),
  // A project's path is a registered root (access.ts `path`): pointing one at someone
  // else's directory would make it yours.
  'POST /api/projects': checked(path('body.path'), computer('body.computerId')),
  'PATCH /api/projects/:id': checked(projectRef('params.id'), path('body.path')),
  'POST /api/projects/:id/skills': checked(projectRef('params.id')),
  'GET /api/projects/resolve-by-path': then(checked(path('query.path')), dataOne('id', 'project')),

  // ── pty (a runtime session key) ──
  'GET /api/pty': listed(bareRows(byField('sessionId', 'session'))),
  'DELETE /api/pty/:id': checked(session('params.id')),
  'GET /api/pty/:id/buffer': checked(session('params.id')),
  'GET /api/pty/:id/follow': checked(session('params.id')),
  'POST /api/pty/:id/submit': checked(session('params.id')),
  'GET /api/pty/:id/wait': checked(session('params.id')),
  'POST /api/pty/:id/write': checked(session('params.id')),
  'POST /api/pty/respawn': checked(task('body.taskId')),
  'POST /api/pty/start': checked(task('body.taskId')),

  // ── terminal tabs ──
  'POST /api/tabs/create': checked(task('body.taskId')),
  'POST /api/tabs/rename': checked(tab('body.id')),
  'POST /api/tabs/split': checked(tab('body.tabId')),

  // ── tags ──
  'GET /api/tags': checked(projectRef('query.project')),
  'POST /api/tags': checked(projectRef('body.project')),
  'DELETE /api/tags/:id': checked(tagPrefix('params.id')),
  'PATCH /api/tags/:id': checked(tagPrefix('params.id')),

  // ── tasks ──
  'GET /api/tasks': listed(
    dataRows('project_id', 'project'),
    'the SQL itself is restricted to the caller’s projects, so `limit` counts only their rows'
  ),
  'GET /api/tasks/search': listed(
    taskRowsById,
    'the SQL itself is restricted to the caller’s projects, so `limit` counts only their rows'
  ),
  'POST /api/tasks': checked(
    projectRef('body.project'),
    projectRef('body.projectId'),
    task('body.parentId'),
    template('body.templateId')
  ),
  'DELETE /api/tasks/:id': checked(taskPrefix('params.id')),
  // A blocker or blocked-by can be in another project (cross-project dependency):
  // those rows are cut, the task itself is the caller's.
  'GET /api/tasks/:id': then(
    checked(taskPrefix('params.id')),
    nestedRows(['blockers', 'blocking'], 'id', 'task')
  ),
  'PATCH /api/tasks/:id': checked(
    taskPrefix('params.id'),
    projectExact('body.projectId'),
    taskPrefix('body.parentId'),
    path('body.worktreePath'),
    path('body.baseDir')
  ),
  'POST /api/tasks/:id/archive': checked(taskPrefix('params.id')),
  'GET /api/tasks/:id/blocked': then(
    checked(taskPrefix('params.id')),
    nestedRows(['blockers'], 'id', 'task')
  ),
  'POST /api/tasks/:id/blocked': then(
    checked(taskPrefix('params.id')),
    nestedRows(['blockers'], 'id', 'task')
  ),
  'DELETE /api/tasks/:id/blockers': then(
    checked(taskPrefix('params.id'), taskPrefix('body.remove[]')),
    taskRowsById
  ),
  'GET /api/tasks/:id/blockers': then(checked(taskPrefix('params.id')), taskRowsById),
  'POST /api/tasks/:id/blockers': then(
    checked(taskPrefix('params.id'), taskPrefix('body.add[]'), taskPrefix('body.set[]')),
    taskRowsById
  ),
  'GET /api/tasks/:id/blocking': then(checked(taskPrefix('params.id')), taskRowsById),
  'POST /api/tasks/:id/done': checked(taskPrefix('params.id')),
  'GET /api/tasks/:id/progress': checked(taskPrefix('params.id')),
  'POST /api/tasks/:id/reset-conversation': checked(taskPrefix('params.id')),
  'GET /api/tasks/:id/subtasks': then(checked(taskPrefix('params.id')), taskRowsById),
  'POST /api/tasks/:id/subtasks': checked(taskPrefix('params.id')),
  'DELETE /api/tasks/:id/tags': checked(taskPrefix('params.id')),
  'POST /api/tasks/:id/tags': checked(taskPrefix('params.id')),
  'POST /api/tasks/:id/unarchive': checked(task('params.id')),
  'POST /api/tasks/archive-many': checked(task('body.ids[]')),

  // ── templates ──
  'GET /api/templates': checked(projectRef('query.project')),
  'POST /api/templates': checked(projectRef('body.project')),
  'DELETE /api/templates/:id': checked(templatePrefix('params.id')),
  'GET /api/templates/:id': checked(templatePrefix('params.id')),
  'PATCH /api/templates/:id': checked(templatePrefix('params.id')),

  // ── `admin` routes (T-106): management, never another user's content (O-6) ──
  // Automations are their project's: an admin manages only those in its own projects.
  'GET /api/automations': checked(projectRef('query.project')),
  'POST /api/automations': checked(projectRef('body.project')),
  'DELETE /api/automations/:id': checked(automationPrefix('params.id')),
  'GET /api/automations/:id': checked(automationPrefix('params.id')),
  'PATCH /api/automations/:id': checked(automationPrefix('params.id')),
  'POST /api/automations/:id/run': checked(automation('params.id')),
  'GET /api/automations/:id/runs': checked(automationPrefix('params.id')),
  'POST /api/computers/join-token': none(COMPUTER),
  'DELETE /api/hub/users': none(ACCOUNTS),
  'GET /api/hub/users': none(ACCOUNTS),
  'PATCH /api/hub/users': none(ACCOUNTS),
  'POST /api/hub/users': none(ACCOUNTS),
  // Break-glass v2 (added): revoke / unrevoke. Metadata only; the handler asks T-19's
  // `mayManageComputer` (an admin: any existing computer), else 404.
  'PATCH /api/hub/computers': none(
    'computer lifecycle (revoked or not): management metadata, decided in the handler by computer-access.ts mayManageComputer (T-19); no content'
  )
}

// ── MCP ───────────────────────────────────────────────────────────────────────

export const MCP_OWNER_POLICY: Record<string, HttpOwnerRule> = {
  archive_many_task: checked(task('ids[]')),
  archive_task: checked(task('id')),
  create_subtask: checked(task('parent_task_id')),
  create_task: checked(projectExact('projectId'), task('parentId'), template('templateId')),
  delete_task: checked(task('id')),
  get_current_task_id: checked(task('task_id')),
  unarchive_task: checked(task('id')),
  update_task: checked(task('task_id'), task('parent_id'))
}
