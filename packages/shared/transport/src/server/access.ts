/**
 * "May this request touch that piece of user content?" — the ONE access function
 * (T-17). Every surface asks it: tRPC through `owner-gate.ts` today, REST, MCP and
 * hooks (T-18) and computers (T-19) next. Transport-agnostic on purpose: it takes a
 * database, the request's facts and a resource, nothing from tRPC or express.
 *
 * THE RULE is T-16's `mayAccessProject` (`@slayzone/projects/server`), applied to the
 * project a resource belongs to. Every resource below resolves to its project(s) —
 * a tab through its task, a pty session through its agent-session row or its
 * `taskId:tabId` key, a turn through its task — and the request may touch it when it
 * may access one of them. So:
 *
 *   - no login (`authRequired: false` — the desktop app's hub): everything, as before;
 *   - login, no principal: nothing;
 *   - login: the project's owner, and nobody else. An admin is no exception: the admin
 *     role manages accounts and computers and gives NO content access (O-6);
 *   - a resource that does not exist, or that has no owner path (a pooled agent
 *     session no task adopted yet, a turn whose task was deleted, a process attached
 *     to neither task nor project, a project T-16's boot backfill left unowned) is
 *     refused to everyone. Callers answer NOT_FOUND either way, so a refusal never
 *     says whether the thing exists.
 *
 * `hub-wide` resolutions are the exception, and the only one: things that belong to
 * no user BY DESIGN (a global AI-config library item, an empty project folder, a
 * filesystem path inside nobody's project) are allowed. Listed per kind below.
 *
 * SHARING (T-100) extends `mayAccessProject` — "owner or member" — plus the facts it
 * needs in {@link ProjectOwnership}. Nothing here or at any call site changes, and
 * a share change calls {@link invalidateAccessCache} so a live stream re-decides.
 *
 * @module transport/server/access
 */
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, posix, resolve as resolvePath, sep, win32 } from 'node:path'
import type { SlayzoneDb } from '@slayzone/platform'
import { mayAccessProject, type ProjectOwnership } from '@slayzone/projects/server'
import { agentSessionsEvents } from '@slayzone/task/server'
import { tabsEvents } from '@slayzone/task-terminals/server'

/**
 * The kinds of user content a request can name.
 *
 *   project · task · tab (terminal/chat tab) · session (pty or agent runtime key)
 *   prompt · turn · artifact · artifactFolder · process · tag · template
 *   testCategory · testLabel · chatQueueItem · automationRun · automation — each
 *   resolves to exactly one project through its row.
 *
 *   aiConfigItem   a project-scoped item → its project; a global library item is
 *                  hub-wide.
 *   projectGroup   the projects in it; an empty folder is hub-wide (it has no owner
 *                  column, and a folder created empty must stay usable by its creator).
 *   path           a filesystem path: the project(s) whose root holds it most
 *                  specifically (a task's worktree or base dir, a project's path, a
 *                  computer placement). Inside the hub's own state directory it is
 *                  refused (the database, auth store and owner token live there) unless
 *                  a project root there is more specific — and an artifact file is its
 *                  task's. Anywhere else it is hub-wide.
 *   computer       a computer (T-19): its OWNER only — `computers.owner_user_id`, not a
 *                  project. A computer is one OS account's environment, so using it is
 *                  code execution in that account: no admin, no sharing, and an unowned
 *                  one is nobody's (O-6). Managing one (list, rename, revoke) is wider —
 *                  the owner or an admin — and is decided in `computer-access.ts`.
 */
export type ResourceKind =
  | 'project'
  | 'task'
  | 'tab'
  | 'session'
  | 'prompt'
  | 'turn'
  | 'artifact'
  | 'artifactFolder'
  | 'process'
  | 'tag'
  | 'template'
  | 'testCategory'
  | 'testLabel'
  | 'chatQueueItem'
  | 'automationRun'
  | 'aiConfigItem'
  | 'projectGroup'
  | 'path'
  | 'automation'
  | 'computer'

export const RESOURCE_KINDS: readonly ResourceKind[] = [
  'project',
  'task',
  'tab',
  'session',
  'prompt',
  'turn',
  'artifact',
  'artifactFolder',
  'process',
  'tag',
  'template',
  'testCategory',
  'testLabel',
  'chatQueueItem',
  'automationRun',
  'aiConfigItem',
  'projectGroup',
  'path',
  'automation',
  'computer'
]

export interface OwnedResource {
  readonly kind: ResourceKind
  /** The row id — or, for `path`, the path. */
  readonly id: string
}

/** Who is asking: `ctx.principal` (tRPC) or the bound REST principal fit as-is. */
export interface AccessPrincipal {
  readonly userId: string
}

export interface AccessRequest {
  /** Whether this hub requires login (`SLAYZONE_HUB_REQUIRE_LOGIN`). */
  readonly authRequired: boolean
  /** The request's verified principal, or null when it carries none. */
  readonly principal: AccessPrincipal | null
  /**
   * Directories holding the hub's own state (`SLAYZONE_ROOT`, the data root). A `path`
   * inside one is nobody's to read or write. Optional: a caller that never resolves
   * paths may omit it.
   */
  readonly hubRoots?: readonly string[]
}

/** What a resource resolved to. */
export type Ownership =
  /** Belongs to these projects; the request needs one of them. */
  | { readonly status: 'projects'; readonly projects: readonly ProjectOwnership[] }
  /** Belongs to no user by design (see {@link ResourceKind}); allowed. */
  | { readonly status: 'hub-wide' }
  /** Missing, or no owner path; refused on a hub with login. */
  | { readonly status: 'none' }

const NONE: Ownership = { status: 'none' }
const HUB_WIDE: Ownership = { status: 'hub-wide' }

/** THE decision, given what the resource resolved to. */
export function decideAccess(req: AccessRequest, ownership: Ownership): boolean {
  if (!req.authRequired) return true
  if (!req.principal) return false
  if (ownership.status === 'hub-wide') return true
  if (ownership.status === 'none') return false
  return ownership.projects.some((p) => mayAccessProject(req, p))
}

// ── resolution: resource → the projects it belongs to ─────────────────────────

type OwnerRow = { owner_user_id: string | null }

const projectsOf = (rows: readonly OwnerRow[]): Ownership =>
  rows.length > 0 ? { status: 'projects', projects: rows } : NONE

/** One row's project, by a query selecting `owner_user_id` for a single id. */
const viaQuery =
  (sql: string) =>
  async (db: SlayzoneDb, id: string): Promise<Ownership> => {
    const row = await db.get<OwnerRow>(sql, [id])
    return row ? projectsOf([row]) : NONE
  }

const OWNER_OF_PROJECT = 'SELECT owner_user_id FROM projects WHERE id = ?'
const OWNER_OF_TASK = `SELECT p.owner_user_id FROM tasks t JOIN projects p ON p.id = t.project_id
  WHERE t.id = ?`
const viaTask = viaQuery(OWNER_OF_TASK)

/**
 * A terminal or chat tab. A task's MAIN tab has the task's id (`ensureMainTab`), and
 * a client names it before the row exists — so an id with no tab row is tried as a
 * task id. A uuid tab with no row matches no task: refused.
 */
async function resolveTab(db: SlayzoneDb, id: string): Promise<Ownership> {
  const row = await db.get<OwnerRow>(
    `SELECT p.owner_user_id FROM terminal_tabs tt JOIN tasks t ON t.id = tt.task_id
      JOIN projects p ON p.id = t.project_id WHERE tt.id = ?`,
    [id]
  )
  return row ? projectsOf([row]) : viaTask(db, id)
}

/** By the project_id column of `table`. */
const viaProjectColumn = (table: string, column = 'project_id') =>
  viaQuery(
    `SELECT p.owner_user_id FROM ${table} x JOIN projects p ON p.id = x.${column} WHERE x.id = ?`
  )
/** By task_id column of `table`. */
const viaTaskColumn = (table: string) =>
  viaQuery(`SELECT p.owner_user_id FROM ${table} x JOIN tasks t ON t.id = x.task_id
    JOIN projects p ON p.id = t.project_id WHERE x.id = ?`)

/**
 * A runtime session key. The agent-session row is authoritative (its id IS the
 * runtime key, `recordSessionSpawn`); a row with no task is a pooled agent nobody
 * adopted yet → no owner. With no row, the legacy `taskId:tabId` key names its task
 * (plain shell tabs, and a spawn whose key is minted before any row exists).
 */
async function resolveSession(db: SlayzoneDb, id: string): Promise<Ownership> {
  const row = await db.get<{ task_id: string | null }>(
    'SELECT task_id FROM agent_sessions WHERE id = ?',
    [id]
  )
  if (row) return row.task_id ? viaTask(db, row.task_id) : NONE
  const colon = id.indexOf(':')
  return colon > 0 ? viaTask(db, id.slice(0, colon)) : NONE
}

async function resolveProcess(db: SlayzoneDb, id: string): Promise<Ownership> {
  const row = await db.get<{ task_id: string | null; project_id: string | null }>(
    'SELECT task_id, project_id FROM processes WHERE id = ?',
    [id]
  )
  if (!row) return NONE
  if (row.task_id) return viaTask(db, row.task_id)
  if (row.project_id) return viaQuery(OWNER_OF_PROJECT)(db, row.project_id)
  return NONE
}

async function resolveAiConfigItem(db: SlayzoneDb, id: string): Promise<Ownership> {
  const row = await db.get<{ project_id: string | null }>(
    'SELECT project_id FROM ai_config_items WHERE id = ?',
    [id]
  )
  if (!row) return NONE
  return row.project_id ? viaQuery(OWNER_OF_PROJECT)(db, row.project_id) : HUB_WIDE
}

async function resolveProjectGroup(db: SlayzoneDb, id: string): Promise<Ownership> {
  const group = await db.get('SELECT id FROM project_groups WHERE id = ?', [id])
  if (!group) return NONE
  const rows = await db.all<OwnerRow>('SELECT owner_user_id FROM projects WHERE group_id = ?', [id])
  return rows.length === 0 ? HUB_WIDE : projectsOf(rows)
}

// ── paths ─────────────────────────────────────────────────────────────────────

const isWindowsPath = (p: string): boolean => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')

/** `abs` through symlinks: the deepest part of it that exists, plus the rest. A path
 *  that does not exist yet (a file about to be written) is judged by where its
 *  existing parent really is. */
function realpathOf(abs: string): string {
  let head = abs
  const tail: string[] = []
  for (;;) {
    try {
      if (existsSync(head))
        return tail.length ? join(realpathSync(head), ...tail.reverse()) : realpathSync(head)
    } catch {
      return abs // unreadable: compare the lexical form
    }
    const parent = dirname(head)
    if (parent === head) return abs
    tail.push(basename(head))
    head = parent
  }
}

/** Registered roots are resolved once per {@link ROOT_TTL_MS}, not per check. */
const ROOT_TTL_MS = 30_000
const rootForms = new Map<string, { form: string; at: number }>()

/**
 * One comparable form of a path. A Windows path (a computer's, seen by a POSIX hub)
 * keeps its own flavour; a POSIX one is resolved against this process — a relative
 * path is what a hub-local operation would open — and through symlinks, so a link
 * cannot smuggle a hub-state path past the check. `cached`: for registered roots.
 */
function normalizePath(p: string, cached = false): string {
  if (isWindowsPath(p)) return win32.normalize(p).replace(/[\\/]+$/, '')
  if (cached) {
    const hit = rootForms.get(p)
    if (hit && Date.now() - hit.at < ROOT_TTL_MS) return hit.form
  }
  const abs = realpathOf(resolvePath(p))
  const form = abs.length > 1 ? abs.replace(/\/+$/, '') : abs
  if (cached) {
    if (rootForms.size > 20_000) rootForms.clear()
    rootForms.set(p, { form, at: Date.now() })
  }
  return form
}

/** `child` is `root` or inside it. */
function within(child: string, root: string): boolean {
  if (child === root) return true
  const s = isWindowsPath(root) ? '\\' : root === posix.sep ? '' : sep
  return child.startsWith(root + s)
}

/** Every registered root a project's content lives under, with its owner. */
const ROOTS_SQL = `
  SELECT r.root AS root, p.owner_user_id AS owner_user_id FROM (
    SELECT project_id, worktree_path AS root FROM tasks WHERE worktree_path IS NOT NULL AND worktree_path <> ''
    UNION ALL SELECT project_id, base_dir FROM tasks WHERE base_dir IS NOT NULL AND base_dir <> ''
    UNION ALL SELECT id, path FROM projects WHERE path IS NOT NULL AND path <> ''
    UNION ALL SELECT project_id, root_path FROM project_placements WHERE root_path <> ''
  ) r JOIN projects p ON p.id = r.project_id`

async function resolvePathResource(
  db: SlayzoneDb,
  rawPath: string,
  hubRoots: readonly string[]
): Promise<Ownership> {
  if (!rawPath) return NONE
  const target = normalizePath(rawPath)
  // The hub's own state directory, as one more root in the competition below.
  let hubDepth = -1
  for (const raw of hubRoots) {
    const root = normalizePath(raw, true)
    if (!within(target, root)) continue
    // `<data root>/artifacts/<taskId>/…` is a task's artifact file (artifact-store).
    const rest = target.slice(root.length + 1).split(/[\\/]/)
    if (rest[0] === 'artifacts' && rest[1]) return viaTask(db, rest[1])
    hubDepth = Math.max(hubDepth, root.length)
  }
  // The most specific root decides: a project nested inside another one is its own,
  // and a broad project somewhere up the tree does not open it to its owner. A
  // project registered INSIDE the hub's directory (a hub started from a home
  // directory) still decides for its own files; anything else in there — the
  // database, the auth store, the owner token — is nobody's. A tie goes to the hub,
  // and a new root cannot be registered there (that path is refused), so nobody can
  // claim the hub's own files by creating a project over them.
  let depth = -1
  let owners: OwnerRow[] = []
  for (const row of await db.all<OwnerRow & { root: string }>(ROOTS_SQL)) {
    const root = normalizePath(row.root, true)
    if (!within(target, root)) continue
    if (root.length > depth) {
      depth = root.length
      owners = []
    }
    if (root.length === depth) owners.push(row)
  }
  if (hubDepth >= 0 && hubDepth >= depth) return NONE
  return depth < 0 ? HUB_WIDE : projectsOf(owners)
}

// ── the resolvers ─────────────────────────────────────────────────────────────

type Resolver = (db: SlayzoneDb, id: string, req: AccessRequest) => Promise<Ownership>

const RESOLVERS: Record<ResourceKind, Resolver> = {
  project: viaQuery(OWNER_OF_PROJECT),
  task: viaTask,
  tab: resolveTab,
  session: resolveSession,
  prompt: viaTaskColumn('agent_prompts'),
  turn: viaTaskColumn('agent_turns'),
  artifact: viaTaskColumn('task_artifacts'),
  artifactFolder: viaTaskColumn('artifact_folders'),
  process: resolveProcess,
  tag: viaProjectColumn('tags'),
  template: viaProjectColumn('task_templates'),
  testCategory: viaProjectColumn('test_categories'),
  testLabel: viaProjectColumn('test_labels'),
  chatQueueItem: viaQuery(`SELECT p.owner_user_id FROM chat_queue q
    JOIN terminal_tabs tt ON tt.id = q.tab_id JOIN tasks t ON t.id = tt.task_id
    JOIN projects p ON p.id = t.project_id WHERE q.id = ?`),
  automationRun: viaQuery(`SELECT p.owner_user_id FROM automation_runs r
    JOIN automations a ON a.id = r.automation_id JOIN projects p ON p.id = a.project_id
    WHERE r.id = ?`),
  aiConfigItem: resolveAiConfigItem,
  projectGroup: resolveProjectGroup,
  path: (db, id, req) => resolvePathResource(db, id, req.hubRoots ?? []),
  // An automation rule (T-106): its project's, like its runs.
  automation: viaProjectColumn('automations'),
  // Its owner row stands in for a project's: it carries no members, so sharing (T-100)
  // never extends to a computer.
  computer: viaQuery('SELECT owner_user_id FROM computers WHERE id = ?')
}

/** What a resource belongs to. Exported for tests and for callers that need the facts. */
export function resolveOwnership(
  db: SlayzoneDb,
  req: AccessRequest,
  resource: OwnedResource
): Promise<Ownership> {
  return RESOLVERS[resource.kind](db, resource.id, req)
}

/**
 * THE access function. Allowed when the hub has no login; otherwise when the
 * principal may access a project the resource belongs to (or it is hub-wide).
 */
export async function canAccess(
  db: SlayzoneDb,
  req: AccessRequest,
  resource: OwnedResource
): Promise<boolean> {
  if (!req.authRequired) return true
  if (!req.principal) return false
  return decideAccess(req, await resolveOwnership(db, req, resource))
}

// ── scopes: many decisions for one request or one live stream ─────────────────

/**
 * Bumped by {@link invalidateAccessCache}. A scope drops its memo when this moves,
 * so a stream re-decides after an ownership change instead of waiting out its TTL.
 */
let generation = 0

/**
 * Something that changes who may see a resource happened: an agent session was
 * adopted by a task (`bindSessionToTask`), a tab appeared — and, with T-100, a share
 * was granted or revoked. Every live scope re-resolves on its next decision.
 */
export function invalidateAccessCache(): void {
  generation++
}

let invalidationWired = false
function wireInvalidation(): void {
  if (invalidationWired) return
  invalidationWired = true
  agentSessionsEvents.on('agent-sessions:changed', invalidateAccessCache)
  tabsEvents.on('tabs:changed', invalidateAccessCache)
}

/**
 * Many decisions under one request: list filtering for one call, or event filtering
 * for one live subscription. Memoized per resource; `allows` answers synchronously
 * once a resource was decided, so a stream filter keeps event order without a
 * database round-trip per event.
 */
export interface AccessScope {
  /** False when the hub has no login: every check passes without a query. */
  readonly enforcing: boolean
  allows(resource: OwnedResource): boolean | Promise<boolean>
  /** Every resource allowed (an empty list: true). */
  allowsAll(resources: readonly OwnedResource[]): Promise<boolean>
  /** The rows whose resource is allowed; a row mapped to null is dropped (ownerless). */
  filter<T>(rows: readonly T[], toResource: (row: T) => OwnedResource | null): Promise<T[]>
  /** Ids of every project the request may access, or null when nothing is restricted. */
  accessibleProjectIds(): Promise<string[] | null>
}

export interface AccessScopeOptions {
  /**
   * How long a decision is reused. Unset: for the scope's whole life — right for a
   * request. A live stream sets one so an ownership change T-100 makes (or one this
   * module was not told about) is picked up; a refusal is reused for at most 1s, so a
   * tab or session row that appears just after its first event does not stay hidden.
   */
  readonly ttlMs?: number
}

const NEGATIVE_TTL_MS = 1_000

export function createAccessScope(
  db: SlayzoneDb,
  req: AccessRequest,
  opts: AccessScopeOptions = {}
): AccessScope {
  const enforcing = req.authRequired
  if (opts.ttlMs !== undefined) wireInvalidation()
  const memo = new Map<string, { allowed: boolean; at: number }>()
  const pending = new Map<string, Promise<boolean>>()
  let seen = generation

  const fresh = (entry: { allowed: boolean; at: number }): boolean => {
    if (opts.ttlMs === undefined) return true
    const ttl = entry.allowed ? opts.ttlMs : Math.min(opts.ttlMs, NEGATIVE_TTL_MS)
    return Date.now() - entry.at < ttl
  }

  const allows = (resource: OwnedResource): boolean | Promise<boolean> => {
    if (!enforcing) return true
    if (!req.principal) return false
    if (seen !== generation) {
      memo.clear()
      seen = generation
    }
    const key = `${resource.kind}\u0000${resource.id}`
    const hit = memo.get(key)
    if (hit && fresh(hit)) return hit.allowed
    const inflight = pending.get(key)
    if (inflight) return inflight
    const p = canAccess(db, req, resource).then(
      (allowed) => {
        memo.set(key, { allowed, at: Date.now() })
        pending.delete(key)
        return allowed
      },
      (err: unknown) => {
        pending.delete(key)
        throw err
      }
    )
    pending.set(key, p)
    return p
  }

  return {
    enforcing,
    allows,
    async allowsAll(resources) {
      for (const r of resources) if (!(await allows(r))) return false
      return true
    },
    async filter(rows, toResource) {
      if (!enforcing) return [...rows]
      const out: (typeof rows)[number][] = []
      for (const row of rows) {
        const r = toResource(row)
        if (r && (await allows(r))) out.push(row)
      }
      return out
    },
    async accessibleProjectIds() {
      if (!enforcing) return null
      if (!req.principal) return []
      const rows = await db.all<OwnerRow & { id: string }>('SELECT id, owner_user_id FROM projects')
      return rows.filter((p) => mayAccessProject(req, p)).map((p) => p.id)
    }
  }
}

/** Shorthand for a resource reference. */
export const resource = (kind: ResourceKind, id: string): OwnedResource => ({ kind, id })
