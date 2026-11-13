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
 * filesystem path inside nobody's project) are allowed. Listed per kind below. A path
 * the hub itself opens for the caller (`ownedPath`, `pathTree`) is never hub-wide
 * (N1), and a path under `/dev`, `/proc`, `/sys` or `/.vol` is nobody's, whatever it
 * is spelled as.
 *
 * SHARING (T-100) extends `mayAccessProject` — "owner or member" — plus the facts it
 * needs in {@link ProjectOwnership}. Nothing here or at any call site changes, and
 * a share change calls {@link invalidateAccessCache} so a live stream re-decides.
 *
 * @module api/access
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, resolve as resolvePath, sep } from 'node:path'
import { HUB_SSO_ENV, type SlayzoneDb } from '@slayzone/platform'
import {
  computerPathWithin,
  isWindowsComputerPath,
  normalizeComputerPath,
  pathFoldsCase
} from '@slayzone/platform/computer-path'
import { securityEvent } from '@slayzone/platform/security-log'
import { mayAccessProject, type ProjectOwnership } from '@slayzone/projects/server'
import { agentSessionsEvents } from '@slayzone/task/server'
import { tabsEvents } from '@slayzone/task-terminals/server'

/**
 * The kinds of user content a request can name.
 *
 *   project · task · tab (terminal/chat tab) · session (pty or agent runtime key)
 *   artifact · artifactFolder · process · tag · template
 *   testCategory · testLabel · automationRun · automation — each
 *   resolves to exactly one project through its row.
 *
 *   aiConfigItem   a project-scoped item → its project; a global library item is
 *                  hub-wide.
 *   projectGroup   the projects in it; an empty folder is hub-wide (it has no owner
 *                  column, and a folder created empty must stay usable by its creator).
 *   path           a filesystem path: the project(s) whose root holds it most
 *                  specifically (a project's path, a computer placement; a task's
 *                  folders are the computer's to judge, §9 7e). Inside the hub's own state directory it is
 *                  refused (the database, auth store and owner token live there) unless
 *                  a project root there is more specific — and an artifact file is its
 *                  task's. Under a system directory ({@link SYSTEM_DIRS}) it is refused.
 *                  Anywhere else it is hub-wide: a folder about to BECOME a root (a new
 *                  project, a new worktree) is in none yet.
 *   ownedPath      `path`, minus hub-wide: a path the hub opens on its OWN disk for the
 *                  caller (copies, reads, git, the OS opener) must lie in a root the
 *                  caller may access. In no root it is nobody's (N1: anything the hub
 *                  process can read — its own database through `/dev/fd/<n>`, its
 *                  environment and auth secret through `/proc/self/environ` — was
 *                  anybody's).
 *                  Only for what still reads the HUB's disk: a procedure that runs on
 *                  a computer is bounded there by that computer's path jail, after the
 *                  gateway's owner check.
 *   computer       a computer (T-19): its OWNER only — `computers.owner_user_id`, not a
 *                  project. A computer is one OS account's environment, so using it is
 *                  code execution in that account: no admin, no sharing, and an unowned
 *                  one is nobody's (O-6). Managing one (list, rename, revoke) is wider —
 *                  the owner or an admin — and is decided in `computer-access.ts`.
 *   pathTree       a directory and everything under it (a directory upload walks it,
 *                  T-107): `ownedPath` for the directory, and refused when a root under
 *                  it is one the request may not touch — the hub's own state, a system
 *                  directory, or a project root of a project it may not access.
 */
export type ResourceKind =
  | 'project'
  | 'task'
  | 'tab'
  | 'session'
  | 'artifact'
  | 'artifactFolder'
  | 'process'
  | 'tag'
  | 'template'
  | 'testCategory'
  | 'testLabel'
  | 'automationRun'
  | 'aiConfigItem'
  | 'projectGroup'
  | 'path'
  | 'automation'
  | 'computer'
  | 'pathTree'
  | 'ownedPath'
  | 'taskMove'

export const RESOURCE_KINDS: readonly ResourceKind[] = [
  'project',
  'task',
  'tab',
  'session',
  'artifact',
  'artifactFolder',
  'process',
  'tag',
  'template',
  'testCategory',
  'testLabel',
  'automationRun',
  'aiConfigItem',
  'projectGroup',
  'path',
  'automation',
  'computer',
  'pathTree',
  'ownedPath',
  'taskMove'
]

/** The kinds whose id is a filesystem path. A path can carry a user's directory
 *  names, so a refusal logs the kind only, never the id. */
export const isPathKind = (kind: ResourceKind): boolean =>
  kind === 'path' || kind === 'ownedPath' || kind === 'pathTree'

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
   * Directories holding the hub's own state (`SLAYZONE_ROOT`, the data root), and its
   * secret files outside them ({@link hubStateRoots}). A `path` inside one is nobody's
   * to read or write. Optional: a caller that never resolves paths may omit it.
   */
  readonly hubRoots?: readonly string[]
  /**
   * The computer the request names (its `target.computerId` / `computerId`), if any:
   * the folder recorded on THAT computer decides a path two users both registered
   * (N4). The gateway's owner check still refuses a computer the caller does not own.
   */
  readonly computerId?: string | null
}

/** The computer a procedure's raw input names — `target.computerId`, else `computerId`. */
export function requestComputerOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as { target?: { computerId?: unknown } | null; computerId?: unknown }
  const named = input.target?.computerId ?? input.computerId
  return typeof named === 'string' && named !== '' ? named : null
}

/**
 * `hubRoots` for this process: the hub's state directories, plus each secret it reads
 * from a file that may live outside them — the Entra certificate and key
 * (`SLAYZONE_HUB_SSO_CERT_PATH` / `_KEY_PATH`, env only). A root that is a file refuses
 * that file, as a directory root refuses everything in it (T-107).
 */
export function hubStateRoots(
  dirs: readonly (string | null | undefined)[],
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return [...dirs, env[HUB_SSO_ENV.certPath], env[HUB_SSO_ENV.keyPath]].filter(
    (r): r is string => !!r
  )
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
 * A runtime session key: `taskId:tabId` names its task. Any other key (a warm-pool
 * agent nobody adopted yet) has no owner. The agent-session ledger is on the
 * computer running the agents (robustness plan §9, P0), not consulted here: a
 * runtime key never needs it.
 */
async function resolveSession(db: SlayzoneDb, id: string): Promise<Ownership> {
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

// A computer path's flavour, its Windows form and the boundary test are the ones git
// routing uses too (`@slayzone/platform/computer-path`): one normalizer, so the two
// never disagree on whose a path is (G2).
const isWindowsPath = isWindowsComputerPath

/** `abs` through symlinks: the deepest part of it that exists, plus the rest. A path
 *  that does not exist yet (a file about to be written) is judged by where its
 *  existing parent really is. `abs` is NOT normalized first and the OS resolves it
 *  (`realpathSync.native`; the JS one collapses `..` before reading links): `link/..`
 *  is the parent of where `link` points, the directory a later open really reaches,
 *  not the directory holding `link` (T-107).
 *
 *  Null: it exists here but cannot be resolved — refused, never compared in its
 *  lexical form. `/.vol/<dev>/<ino>` (macOS) opens any file by its inode, and realpath
 *  cannot spell it: read lexically, it was nobody's, so anyone could read the hub's
 *  database through it (L6). */
function realpathOf(abs: string): string | null {
  let head = abs
  const tail: string[] = []
  for (;;) {
    let exists: boolean
    try {
      exists = existsSync(head)
    } catch {
      return null
    }
    if (exists) {
      try {
        const real = realpathSync.native(head)
        return tail.length ? join(real, ...tail.reverse()) : real
      } catch {
        return null
      }
    }
    const parent = dirname(head)
    if (parent === head) return resolvePath(abs)
    tail.push(basename(head))
    head = parent
  }
}

/**
 * Directories whose entries are not files anyone keeps there: device nodes and the
 * kernel's views of processes. `/dev/fd/<n>` and `/dev/stdin` read whatever the hub
 * has open (its database), `/proc/self/environ` its environment (the auth secret),
 * `/.vol/<dev>/<inode>` (macOS) any file by number past every path check. Their
 * realpath names nothing real (`/dev/fd/node`), so no root could ever hold them.
 */
const SYSTEM_DIRS = ['/dev', '/proc', '/sys', '/.vol'] as const

/** `p` (absolute, POSIX) is a system directory or under one. Case-folded: macOS's
 *  default volume is case-insensitive, so `/DEV/fd/3` opens `/dev/fd/3` (on Linux it
 *  refuses a `/DEV` nobody keeps project files in). */
const inSystemDir = (p: string): boolean => {
  const lower = p.toLowerCase()
  return SYSTEM_DIRS.some((d) => lower === d || lower.startsWith(`${d}/`))
}

/** Registered roots are resolved once per {@link ROOT_TTL_MS}, not per check. */
const ROOT_TTL_MS = 30_000
const rootForms = new Map<string, { form: string | null; at: number }>()

/**
 * One comparable form of a path, or null when it cannot be resolved (refused). A
 * Windows path seen by a POSIX hub is a computer's and keeps its own flavour; any
 * other path is resolved against this process — a relative path is what a hub-local
 * operation would open — and through symlinks, so a link cannot smuggle a hub-state
 * path past the check. `cached`: for registered roots.
 */
function normalizePath(p: string, cached = false): string | null {
  if (isWindowsPath(p) && process.platform !== 'win32') return normalizeComputerPath(p)
  if (cached) {
    const hit = rootForms.get(p)
    if (hit && Date.now() - hit.at < ROOT_TTL_MS) return hit.form
  }
  const form = resolveHere(p)
  if (cached) {
    if (rootForms.size > 20_000) rootForms.clear()
    rootForms.set(p, { form, at: Date.now() })
  }
  return form
}

/**
 * `p` resolved on this disk, or null — refused: it cannot be resolved, or it is a
 * system directory or under one, spelled so (`..` collapsed) or once links are
 * followed (N1: realpath of a descriptor names nothing real, `/dev/fd/node`; a link
 * elsewhere can point into one).
 */
function resolveHere(p: string): string | null {
  const abs = isAbsolute(p) ? p : `${process.cwd()}${sep}${p}`
  if (!isWindowsPath(abs) && inSystemDir(posix.resolve(abs))) return null
  const real = realpathOf(abs)
  if (real === null || (!isWindowsPath(real) && inSystemDir(real))) return null
  if (isWindowsPath(real)) return normalizeComputerPath(real)
  // NFC, as every other SlayZone comparison of a path (`computer-path.ts`).
  return (real.length > 1 ? real.replace(/\/+$/, '') : real).normalize('NFC')
}

// ── identity: the same folder under another name ──────────────────────────────
//
// Some names of a folder are not its realpath and never become it: macOS firmlinks
// (`/System/Volumes/Data/Users/…` IS `/Users/…`), bind mounts. Lexically such a path
// is inside no root — nobody's, so anyone's (L6). The folder's identity (`dev:ino`)
// is the same under every name, as the computer's jail already compares it: a root
// contains a path when the root's identity is one of the path's existing folders.

/** `dev:ino` of what `p` names here, or null (nothing there). */
function identityOf(p: string): string | null {
  try {
    const st = statSync(p)
    return `${st.dev}:${st.ino}`
  } catch {
    return null
  }
}

const rootIdentities = new Map<string, { id: string | null; at: number }>()

/** A registered root's identity here, cached like its form; null when not here. */
function rootIdentity(root: string): string | null {
  if (isWindowsPath(root) && process.platform !== 'win32') return null
  const hit = rootIdentities.get(root)
  if (hit && Date.now() - hit.at < ROOT_TTL_MS) return hit.id
  const id = identityOf(root)
  if (rootIdentities.size > 20_000) rootIdentities.clear()
  rootIdentities.set(root, { id, at: Date.now() })
  return id
}

/** Each existing folder from `p` up, by identity → its spelling as a prefix of `p`. */
type Ancestry = ReadonlyMap<string, string>

function ancestryOf(p: string): Ancestry {
  const out = new Map<string, string>()
  if (isWindowsPath(p) && process.platform !== 'win32') return out
  let current = p
  for (;;) {
    const id = identityOf(current)
    if (id && !out.has(id)) out.set(id, current)
    const parent = dirname(current)
    if (parent === current) return out
    current = parent
  }
}

const rootAncestries = new Map<string, { ancestry: Ancestry; at: number }>()

/**
 * A registered root's {@link ancestryOf}, remembered for {@link ROOT_TTL_MS} like its
 * form and identity: a tree check asks it of EVERY root, and uncached that was every
 * folder above every task's worktree, statted on each check (N5).
 */
function rootAncestry(root: string): Ancestry {
  const hit = rootAncestries.get(root)
  if (hit && Date.now() - hit.at < ROOT_TTL_MS) return hit.ancestry
  const ancestry = ancestryOf(root)
  if (rootAncestries.size > 20_000) rootAncestries.clear()
  rootAncestries.set(root, { ancestry, at: Date.now() })
  return ancestry
}

/**
 * Where in `target` the root `root` ends (its length there), or -1 when `target` is
 * not `root` or inside it — by name (`inside`), else by identity.
 */
function rootEnd(
  target: string,
  ancestry: Ancestry,
  root: string,
  inside: (child: string, root: string) => boolean
): number {
  if (inside(target, root)) return root.length
  const id = rootIdentity(root)
  const at = id ? ancestry.get(id) : undefined
  return at === undefined ? -1 : at.length
}

/**
 * `child` is `root` or inside it — `root` a PROJECT root, i.e. a folder on some
 * computer. Letter case is compared exactly (a Windows path is always folded): whether
 * a volume folds case is the owning computer's to say, and this hub's disk says
 * nothing about it — probing it let `/home/u/PROJ` and `/home/u/proj` of two users on
 * a case-sensitive computer tie, and the tie let either in (L3). A case variant of a
 * path that exists here is folded by `realpathOf` already (the OS spells it as stored);
 * one that matches no root exactly is nobody's here, and the work it names goes to the
 * caller's own computer, whose jail folds case for its own volume.
 */
const within = (child: string, root: string): boolean => computerPathWithin(child, root)

/**
 * `child` is the hub's own state root `root` or inside it. That root IS on this disk,
 * so this disk decides its case folding (a variant spelling that does not exist yet
 * must not slip past it either).
 */
const withinHubRoot = (child: string, root: string): boolean =>
  computerPathWithin(child, root, pathFoldsCase(root))

/** A hub state root's form; one that cannot be resolved is still protected, lexically. */
const hubRootForm = (raw: string): string => normalizePath(raw, true) ?? resolvePath(raw)

/**
 * `rawPath` is `rawRoot` or inside it, after both are resolved the way every path
 * check here resolves them (`..` and symlinks included). Empty never matches.
 */
export function pathIsWithin(rawPath: string, rawRoot: string): boolean {
  if (!rawPath || !rawRoot) return false
  const target = normalizePath(rawPath)
  const root = normalizePath(rawRoot, true)
  if (target === null || root === null) return false
  return rootEnd(target, ancestryOf(target), root, within) >= 0
}

// ── roots: who owns a folder, by the disk it is on ────────────────────────────
//
// ONE resolver ({@link resolvePathResource}) decides a path against a set of roots;
// WHICH roots is its input, by the disk the read happens on (Q1):
//
//   computer disk  every recorded root, with the computer it is on: a project's folder
//                  on each computer (`project_placements`), and a pre-v176 project
//                  path. A task's worktree / base dir is not the hub's to know (§9 7e,
//                  v211): every request touching one names its task, and the computer
//                  confines the path to that task's folders. In a tie, a pre-v176 path of a project that
//                  has a placement does not count — the placement is where its folder
//                  is now (Q2: as a computer-less owner it made the tie unbreakable and
//                  locked its owner out on their own computer).
//   hub disk       only records OF the hub's disk: project paths (not one of a project
//                  that has a placement: its folder is on a computer now, and the old
//                  path is stale — M8), and the worktrees and
//                  folders of the hub's own computer (the desktop's co-spawned one,
//                  {@link setHubDiskComputer}). A task on NO computer is not one: removing
//                  a computer clears its tasks' computer, so a user could turn the
//                  worktrees their own remote computer reported into "hub-side" ones. What a remote
//                  computer reports describes ITS disk: counted here, a user's computer
//                  reporting `/` gave them every hub file, and reporting someone else's
//                  folder locked its owner out.

/** Where a path is read, and so which records say who owns it. */
type RootSource = 'computer-disk' | 'hub-disk'

const COMPUTER_DISK_ROOTS_SQL = `
  SELECT r.root AS root, r.computer_id AS computer_id, p.owner_user_id AS owner_user_id,
    EXISTS (SELECT 1 FROM project_placements pp WHERE pp.project_id = p.id AND pp.root_path <> '') AS placed
  FROM (
    SELECT id AS project_id, path AS root, NULL AS computer_id FROM projects WHERE path IS NOT NULL AND path <> ''
    UNION ALL SELECT project_id, root_path, computer_id FROM project_placements WHERE root_path <> ''
  ) r JOIN projects p ON p.id = r.project_id`

/** Project folders of the hub's disk. Its tasks' folders come from its computer (§9 7c). */
const HUB_DISK_ROOTS_SQL = `
  SELECT r.root AS root, r.computer_id AS computer_id, p.owner_user_id AS owner_user_id,
    EXISTS (SELECT 1 FROM project_placements pp WHERE pp.project_id = p.id AND pp.root_path <> '') AS placed
  FROM (
    SELECT id AS project_id, path AS root, NULL AS computer_id FROM projects WHERE path IS NOT NULL AND path <> ''
      AND NOT EXISTS (SELECT 1 FROM project_placements pp WHERE pp.project_id = projects.id AND pp.root_path <> '')
    UNION ALL SELECT project_id, root_path, computer_id FROM project_placements WHERE root_path <> ''
      AND computer_id = ?
  ) r JOIN projects p ON p.id = r.project_id`

/** The owner (by the HUB's task → project record) of each task a root belongs to. */
const TASK_OWNERS_SQL = (n: number) => `
  SELECT t.id AS task_id, p.owner_user_id AS owner_user_id,
    EXISTS (SELECT 1 FROM project_placements pp WHERE pp.project_id = p.id AND pp.root_path <> '') AS placed
  FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id IN (${Array(n).fill('?').join(',')})`

/** A task's folder (its worktree or base dir) as the computer holding it reports. */
export interface TaskRoot {
  taskId: string
  root: string
}

/**
 * The folders of the tasks of the hub's own computer, read from THAT computer (§9
 * Phase 7c: the hub keeps no task path). Set by the hub's composition; unset, or the
 * computer away, there are none — a path in a task folder then belongs to nobody
 * (refused), never to someone by a stale copy.
 */
let hubDiskTaskRoots: (() => Promise<TaskRoot[]>) | null = null
export function setHubDiskTaskRoots(source: (() => Promise<TaskRoot[]>) | null): void {
  hubDiskTaskRoots = source
  invalidateAccessCache()
}

/** Task roots as root rows: owner by the hub's task → project record, never the computer's. */
async function taskRootRows(
  db: SlayzoneDb,
  roots: readonly TaskRoot[],
  computerId: string
): Promise<RootRow[]> {
  const ids = [...new Set(roots.map((r) => r.taskId))]
  const owners = new Map<string, OwnerRow & { placed: number }>()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    for (const row of await db.all<OwnerRow & { task_id: string; placed: number }>(
      TASK_OWNERS_SQL(chunk.length),
      chunk
    ))
      owners.set(row.task_id, row)
  }
  const out: RootRow[] = []
  for (const r of roots) {
    const owner = owners.get(r.taskId)
    if (owner && r.root)
      out.push({
        root: r.root,
        computer_id: computerId,
        owner_user_id: owner.owner_user_id,
        placed: owner.placed
      })
  }
  return out
}

/**
 * The computer that shares the hub's disk — the desktop app's co-spawned local
 * computer — or null (a standalone hub: no computer's folders are on its disk). Set
 * by the hub's composition.
 */
let hubDiskComputerId: string | null = null
export function setHubDiskComputer(computerId: string | null): void {
  hubDiskComputerId = computerId
  invalidateAccessCache()
}

async function rootsOf(db: SlayzoneDb, source: RootSource): Promise<RootRow[]> {
  if (source === 'computer-disk') return db.all<RootRow>(COMPUTER_DISK_ROOTS_SQL)
  const local = hubDiskComputerId ?? ''
  const projects = await db.all<RootRow>(HUB_DISK_ROOTS_SQL, [local])
  if (!hubDiskComputerId || !hubDiskTaskRoots) return projects
  const tasks = await hubDiskTaskRoots().catch(() => [] as TaskRoot[])
  return [...projects, ...(await taskRootRows(db, tasks, hubDiskComputerId))]
}

/** `/`, a drive root (`C:\`) or a share root: never a project folder. */
function isFilesystemRoot(root: string): boolean {
  if (!isWindowsPath(root)) return root === '/'
  return /^[a-z]:\\?$/i.test(root) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(root)
}

/** What a path resolution may answer for a path in no root. */
type InNoRoot = 'hub-wide' | 'nobody'

async function resolvePathResource(
  db: SlayzoneDb,
  rawPath: string,
  hubRoots: readonly string[],
  inNoRoot: InNoRoot = 'hub-wide',
  computerId: string | null = null,
  source: RootSource = 'computer-disk'
): Promise<Ownership> {
  if (!rawPath) return NONE
  const target = normalizePath(rawPath)
  if (target === null) return NONE
  const ancestry = ancestryOf(target)
  // The hub's own state directory, as one more root in the competition below.
  let hubDepth = -1
  for (const raw of hubRoots) {
    const root = hubRootForm(raw)
    const end = rootEnd(target, ancestry, root, withinHubRoot)
    if (end < 0) continue
    // `<data root>/artifacts/<taskId>/…` is a task's artifact file (artifact-store).
    const rest = target.slice(end + 1).split(/[\\/]/)
    if (rest[0] === 'artifacts' && rest[1]) return viaTask(db, rest[1])
    // How deep in `target` the root reaches — not how it is spelled: a firmlink
    // (`/System/Volumes/Data/…`) is a longer spelling of the same folder (M8).
    hubDepth = Math.max(hubDepth, end)
  }
  // The most specific root decides: a project nested inside another one is its own,
  // and a broad project somewhere up the tree does not open it to its owner. A
  // project registered INSIDE the hub's directory (a hub started from a home
  // directory) still decides for its own files; anything else in there — the
  // database, the auth store, the owner token — is nobody's. A tie goes to the hub,
  // and a new root cannot be registered there (that path is refused), so nobody can
  // claim the hub's own files by creating a project over them.
  let depth = -1
  let owners: RootRow[] = []
  for (const row of await rootsOf(db, source)) {
    // A request that names its computer is about that computer's disk: another
    // computer's folders never decide for it (M9: A's /home/u/app on A's computer
    // locked B out of B's /home/u on B's). Legacy (computer-less) roots still count.
    if (computerId && row.computer_id !== null && row.computer_id !== computerId) continue
    const root = normalizePath(row.root, true)
    // A filesystem root is no project folder: as one it would own every path (M9).
    if (root === null || isFilesystemRoot(root)) continue
    const end = rootEnd(target, ancestry, root, within)
    if (end < 0) continue
    if (end > depth) {
      depth = end
      owners = []
    }
    if (end === depth) owners.push(row)
  }
  if (hubDepth >= 0 && hubDepth >= depth) return NONE
  if (depth < 0) return inNoRoot === 'hub-wide' ? HUB_WIDE : NONE
  // The same folder recorded for two users (each on their own computer): which one
  // a path means is not the hub's to guess — a tie between owners never grants
  // access by path alone (L3). A request that names its computer is decided by the
  // folder recorded on that computer (N4: else user A could lock user B out of B's
  // own folder by registering a project at it on A's computer).
  //
  // Only for a path read ON that computer (`path`): a hub-disk read (`ownedPath`,
  // `pathTree`) never gets a computer here — the computer a request names says
  // nothing about the hub's disk (P2: A placed B's folder on A's own computer, named
  // it, and read B's file off the hub). And a root with no computer (the hub's own,
  // or a legacy one) never loses a tie because a computer was named: the tie denies.
  if (new Set(owners.map((o) => o.owner_user_id)).size > 1) {
    // A pre-v176 path of a project with a placement is that project's old spelling of
    // the same folder, not one more owner (Q2).
    const contenders = owners.filter((o) => o.computer_id !== null || !o.placed)
    // Without those, one owner left: theirs — a computer named or not (M8).
    if (contenders.length > 0 && new Set(contenders.map((o) => o.owner_user_id)).size === 1) {
      return projectsOf(contenders)
    }
    const allOnComputers = contenders.every((o) => o.computer_id !== null)
    const onIt =
      computerId && allOnComputers ? contenders.filter((o) => o.computer_id === computerId) : []
    if (onIt.length > 0 && new Set(onIt.map((o) => o.owner_user_id)).size === 1) {
      return projectsOf(onIt)
    }
    // Audited: a user may be locked out of a folder by someone else's project.
    // Never the path itself — it can carry a user's directory names.
    securityEvent({
      event: 'authz.path_tie',
      outcome: 'denied',
      targetKind: 'path',
      targetId: null,
      detail: { owners: owners.length, computerNamed: computerId !== null }
    })
    return NONE
  }
  return projectsOf(owners)
}

/** A registered root, with the project owner and the computer it is recorded on. */
type RootRow = OwnerRow & {
  root: string
  computer_id: string | null
  /** The row's project has a folder on some computer (`project_placements`). */
  placed: number
}

/**
 * A directory and everything under it. What decides the directory as an `ownedPath`
 * decides here too, but a walk also reaches every root nested inside it — so the
 * hub's own state there (a directory up the tree from `<ROOT>`, or holding the SSO
 * key), a system directory, or a project root the request may not access (another
 * user's project nested in yours, their worktree) refuses the whole tree. Symlinks
 * inside are not followed by the walk; one AT the directory is resolved like any
 * `ownedPath`.
 */
async function resolvePathTree(
  db: SlayzoneDb,
  rawPath: string,
  req: AccessRequest
): Promise<Ownership> {
  const hubRoots = req.hubRoots ?? []
  // A walk of the hub's disk: no computer breaks a tie there (P2).
  const own = await resolvePathResource(db, rawPath, hubRoots, 'nobody', null, 'hub-disk')
  if (own.status === 'none') return NONE
  const dir = normalizePath(rawPath)
  if (dir === null) return NONE
  const dirId = rootIdentity(dir)
  // A root inside `dir`: by name, or by identity (`dir` is one of its folders).
  const holds = (root: string, inside: (child: string, root: string) => boolean) =>
    inside(root, dir) || (dirId !== null && rootAncestry(root).has(dirId))
  for (const raw of hubRoots) if (holds(hubRootForm(raw), withinHubRoot)) return NONE
  // A walk from `/` (or any folder holding one) would reach a system directory.
  if (!isWindowsPath(dir) && SYSTEM_DIRS.some((d) => holds(d, within))) return NONE
  for (const row of await rootsOf(db, 'hub-disk')) {
    const root = normalizePath(row.root, true)
    if (root !== null && holds(root, within) && !mayAccessProject(req, row)) return NONE
  }
  return own
}

async function resolveTaskMove(db: SlayzoneDb, id: string): Promise<Ownership> {
  const here = await db.get<{ task_id: string }>(
    `SELECT mt.task_id FROM task_move_tasks mt JOIN tasks t ON t.id = mt.task_id
      WHERE mt.move_id = ? LIMIT 1`,
    [id]
  )
  if (here) return viaTask(db, here.task_id)
  // A project move (one with no task, or none left here): its project, while here.
  const project = await db.get<{ project_id: string }>(
    `SELECT m.project_id FROM task_moves m JOIN projects p ON p.id = m.project_id
      WHERE m.id = ? AND m.scope = 'project'`,
    [id]
  )
  if (project) return viaQuery(OWNER_OF_PROJECT)(db, project.project_id)
  return viaQuery('SELECT created_by AS owner_user_id FROM task_moves WHERE id = ?')(db, id)
}

// ── the resolvers ─────────────────────────────────────────────────────────────

type Resolver = (db: SlayzoneDb, id: string, req: AccessRequest) => Promise<Ownership>

const RESOLVERS: Record<ResourceKind, Resolver> = {
  project: viaQuery(OWNER_OF_PROJECT),
  task: viaTask,
  tab: resolveTab,
  session: resolveSession,
  artifact: viaTaskColumn('task_artifacts'),
  artifactFolder: viaTaskColumn('artifact_folders'),
  process: resolveProcess,
  tag: viaProjectColumn('tags'),
  template: viaProjectColumn('task_templates'),
  testCategory: viaProjectColumn('test_categories'),
  testLabel: viaProjectColumn('test_labels'),
  automationRun: viaQuery(`SELECT p.owner_user_id FROM automation_runs r
    JOIN automations a ON a.id = r.automation_id JOIN projects p ON p.id = a.project_id
    WHERE r.id = ?`),
  aiConfigItem: resolveAiConfigItem,
  projectGroup: resolveProjectGroup,
  path: (db, id, req) =>
    resolvePathResource(db, id, req.hubRoots ?? [], 'hub-wide', req.computerId ?? null),
  // An automation rule (T-106): its project's, like its runs.
  automation: viaProjectColumn('automations'),
  // Its owner row stands in for a project's: it carries no members, so sharing (T-100)
  // never extends to a computer.
  computer: viaQuery('SELECT owner_user_id FROM computers WHERE id = ?'),
  pathTree: resolvePathTree,
  // A path the hub opens on its own disk for the caller: a root of theirs, or nothing (N1).
  // Read on the hub's disk: no computer breaks a tie there (P2).
  ownedPath: (db, id, req) =>
    resolvePathResource(db, id, req.hubRoots ?? [], 'nobody', null, 'hub-disk'),
  // A move to another hub: its tasks' while they are here; once they left (released),
  // whoever began it.
  taskMove: resolveTaskMove
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
