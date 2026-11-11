/**
 * A task's worktree path and base dir, kept only on this computer (robustness plan
 * §9, P0; Phase 7a, hub migration v210). This computer runs every write: set (a
 * created or moved worktree, an edited base dir, a project change), inherit (a
 * subtask takes its parent's paths as held HERE), clear (archive). A write carries
 * the time the hub accepted it; the newest wins, so a hand-off delivered late or
 * twice never rolls a path back. A deleted task writes nothing and its row goes
 * with the task's purge.
 *
 * {@link scopeBounds} names the roots a request's paths are confined to (Phase 7b
 * on): a task's worktree and base dir and its project's folder on this computer; a
 * project's folder, its worktree bases and its tasks' roots. Never another task's
 * worktree from a task scope, never another project's roots from a project scope.
 *
 * @module chat-runtime/server/task-paths
 */
import {
  type TaskPathRelease,
  type TaskPathRow,
  type TaskPathsRequest,
  type TaskPathValue,
  taskPathsRequestSchema,
  taskPathValueSchema
} from '../shared/task-paths'
import { isAbsolute, relative } from 'node:path'
import type { ChatStorage } from './storage'
import type { DataImportKind } from './task-data'

interface Row {
  task_id: string
  project_id: string | null
  worktree_path: string | null
  base_dir: string | null
  updated_at: number
}

const toRow = (r: Row): TaskPathRow => ({
  taskId: r.task_id,
  projectId: r.project_id,
  worktreePath: r.worktree_path,
  baseDir: r.base_dir,
  at: r.updated_at
})

/**
 * How long a purged task's worktree path waits for the hub's `forget` (the hub then
 * removed the checkout, or found it shared). Past it the path goes regardless: a
 * path can carry a task's title, and nothing is kept forever.
 */
export const TASK_PATH_RELEASE_TTL_MS = 30 * 24 * 60 * 60_000

/** The `task_paths` table of this computer's chat store. */
export function taskPathsStore(storage: ChatStorage) {
  const db = storage.compose((raw) => raw)
  const select = (taskId: string) =>
    db.prepare('SELECT * FROM task_paths WHERE task_id=?').get(taskId) as Row | undefined
  return {
    get(taskId: string): TaskPathRow | null {
      const r = select(taskId)
      return r ? toRow(r) : null
    },
    /**
     * Write the task's row as of `at`, keeping fields left `undefined`. Refused for a
     * deleted task and when a newer write is stored. Returns whether it applied.
     */
    write(
      taskId: string,
      value: {
        projectId: string | null
        worktreePath?: string | null
        baseDir?: string | null
        at: number
      }
    ): boolean {
      if (storage.taskLifecycle(taskId).state === 'deleted') return false
      const current = select(taskId)
      if (current && current.updated_at > value.at) return false
      db.prepare(
        `INSERT INTO task_paths(task_id, project_id, worktree_path, base_dir, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET project_id=excluded.project_id,
           worktree_path=excluded.worktree_path, base_dir=excluded.base_dir,
           updated_at=excluded.updated_at`
      ).run(
        taskId,
        value.projectId,
        value.worktreePath === undefined ? (current?.worktree_path ?? null) : value.worktreePath,
        value.baseDir === undefined ? (current?.base_dir ?? null) : value.baseDir,
        value.at
      )
      return true
    },
    /**
     * Every other task's worktree and base dir here, apart: a worktree is a separate
     * checkout (carved out of a task scope); a base dir is a plain folder (S4).
     */
    others(taskId: string): { worktrees: string[]; baseDirs: string[] } {
      const rows = db
        .prepare(
          'SELECT worktree_path, base_dir FROM task_paths WHERE task_id<>? AND (worktree_path IS NOT NULL OR base_dir IS NOT NULL)'
        )
        .all(taskId) as Array<Pick<Row, 'worktree_path' | 'base_dir'>>
      const set = (xs: Array<string | null>) => [
        ...new Set(xs.filter((p): p is string => p !== null))
      ]
      return {
        worktrees: set(rows.map((r) => r.worktree_path)),
        baseDirs: set(rows.map((r) => r.base_dir))
      }
    },
    /**
     * The roots (worktrees and base dirs) of the tasks held here for `projectId`
     * (`own`) and of every other task held here (`others`, another project's or none):
     * a project scope covers its tasks' folders, and no other task's (B1).
     */
    ofProject(projectId: string): { own: string[]; others: string[] } {
      const rows = db
        .prepare(
          'SELECT project_id, worktree_path, base_dir FROM task_paths WHERE worktree_path IS NOT NULL OR base_dir IS NOT NULL'
        )
        .all() as Array<Pick<Row, 'project_id' | 'worktree_path' | 'base_dir'>>
      const own = new Set<string>()
      const others = new Set<string>()
      for (const r of rows) {
        const into = r.project_id === projectId ? own : others
        for (const p of [r.worktree_path, r.base_dir]) if (p !== null) into.add(p)
      }
      return { own: [...own], others: [...others] }
    },
    getMany(taskIds: string[]): TaskPathRow[] {
      const out: TaskPathRow[] = []
      for (const taskId of taskIds) {
        const r = select(taskId)
        if (r) out.push(toRow(r))
      }
      return out
    },
    /**
     * The task whose worktree each of `paths` is (usage-log attribution by the
     * session's folder, §9 Phase 7c). A worktree a subtask shares goes to the task
     * that held it first here (the one that made it), as the hub attributed it.
     */
    byWorktree(paths: string[]): Record<string, string> {
      const out: Record<string, string> = {}
      const query = db.prepare(
        'SELECT task_id FROM task_paths WHERE worktree_path=? ORDER BY rowid LIMIT 1'
      )
      for (const path of new Set(paths)) {
        const row = query.get(path) as { task_id: string } | undefined
        if (row) out[path] = row.task_id
      }
      return out
    },
    /**
     * Forget a deleted task's row (in the purge's transaction). Its worktree path is
     * kept in `task_path_releases` until the hub removed the checkout (`forget`).
     */
    deleteForTask(taskId: string, now: number): void {
      db.prepare(
        `INSERT INTO task_path_releases(task_id, project_id, worktree_path, released_at)
         SELECT task_id, project_id, worktree_path, ? FROM task_paths
          WHERE task_id=? AND worktree_path IS NOT NULL
         ON CONFLICT(task_id) DO UPDATE SET worktree_path=excluded.worktree_path,
           project_id=excluded.project_id, released_at=excluded.released_at`
      ).run(now, taskId)
      db.prepare('DELETE FROM task_paths WHERE task_id=?').run(taskId)
    },
    /** The worktree to remove for `taskId` (held or purged here), and whether it is shared. */
    release(taskId: string, liveTaskIds: readonly string[]): TaskPathRelease {
      const own =
        select(taskId)?.worktree_path ??
        (
          db.prepare('SELECT worktree_path FROM task_path_releases WHERE task_id=?').get(taskId) as
            | { worktree_path: string }
            | undefined
        )?.worktree_path ??
        null
      if (own === null) return { worktreePath: null, shared: false }
      const live = new Set(liveTaskIds)
      live.delete(taskId)
      const sharers = db
        .prepare('SELECT task_id FROM task_paths WHERE worktree_path=? AND task_id<>?')
        .all(own, taskId) as Array<{ task_id: string }>
      return { worktreePath: own, shared: sharers.some((r) => live.has(r.task_id)) }
    },
    /** The hub is done with a purged task's checkout; old releases expire too. */
    forget(taskId: string, now: number): void {
      db.prepare('DELETE FROM task_path_releases WHERE task_id=? OR released_at<?').run(
        taskId,
        now - TASK_PATH_RELEASE_TTL_MS
      )
    }
  }
}

export function createTaskPaths(storage: ChatStorage, now: () => number = Date.now) {
  const store = taskPathsStore(storage)
  // A deleted task's paths go with its other content; its worktree path waits for the
  // hub to remove the checkout (`release` / `forget`).
  storage.onTaskPurge((taskId) => store.deleteForTask(taskId, now()))

  function handle(raw: unknown): unknown {
    const request: TaskPathsRequest = taskPathsRequestSchema.parse(raw)
    switch (request.op) {
      case 'set':
        return {
          applied: storage.transaction(() =>
            store.write(request.taskId, {
              projectId: request.projectId,
              worktreePath: request.worktreePath,
              baseDir: request.baseDir,
              at: request.at
            })
          )
        }
      case 'inherit':
        return storage.transaction(() => {
          const parent = store.get(request.parentTaskId)
          if (!parent) return { inherited: false }
          store.write(request.taskId, {
            projectId: request.projectId,
            worktreePath: parent.worktreePath,
            baseDir: parent.baseDir,
            at: request.at
          })
          return { inherited: true }
        })
      case 'clear':
        return {
          applied: storage.transaction(() => {
            const current = store.get(request.taskId)
            return store.write(request.taskId, {
              projectId: current?.projectId ?? null,
              worktreePath: null,
              baseDir: null,
              at: request.at
            })
          })
        }
      case 'get':
        return store.getMany(request.taskIds)
      case 'release':
        return store.release(request.taskId, request.liveTaskIds)
      case 'forget':
        storage.transaction(() => store.forget(request.taskId, now()))
        return { forgotten: true }
    }
  }

  return {
    store,
    /** One `chat.request` of kind `taskPaths`. */
    handle,
    get: (taskId: string): TaskPathRow | null => store.get(taskId),
    others: (taskId: string): { worktrees: string[]; baseDirs: string[] } => store.others(taskId),
    ofProject: (projectId: string): { own: string[]; others: string[] } =>
      store.ofProject(projectId),
    byWorktree: (paths: string[]): Record<string, string> => store.byWorktree(paths)
  }
}
export type TaskPaths = ReturnType<typeof createTaskPaths>

/** One `task-path` hand-off item: the hub's row as of `value.at`; a newer row here stays. */
export const taskPathImport: DataImportKind<TaskPathValue> = {
  value: taskPathValueSchema,
  apply(storage, item) {
    const store = taskPathsStore(storage)
    const { inheritFrom, ...value } = item.value
    if (inheritFrom === undefined) {
      store.write(item.taskId, value)
      return
    }
    // A parent this computer does not hold has no paths here: nothing to copy. A field
    // the row also gives was written after the inherit (the hub merges later writes into
    // the staged row): it wins over the copy.
    const parent = store.get(inheritFrom)
    store.write(item.taskId, {
      projectId: value.projectId,
      worktreePath:
        value.worktreePath !== undefined ? value.worktreePath : (parent?.worktreePath ?? null),
      baseDir: value.baseDir !== undefined ? value.baseDir : (parent?.baseDir ?? null),
      at: value.at
    })
  }
}

/** `p` is `root` or lies under it (lexically: both absolute, already normalized). */
function isWithin(p: string, root: string): boolean {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * What one request's path scope may touch on this computer (`@slayzone/platform/
 * path-scope`; the path jail enforces it on top of the machine bound).
 *
 * - A task: its own roots — its worktree and its base dir, each a folder the task
 *   declared (created for it, or the user chose it: B3, a folder outside the project,
 *   one another task shares, one inside another project's folder) — and its project's
 *   folder here (the checkout its worktree belongs to: merge into the parent branch,
 *   copy ignored files, the repo of `git worktree add`). The project is the one this
 *   computer recorded for the task, else the one the hub names (task → project is hub
 *   data). Every OTHER task's WORKTREE is carved out (`excluded`), so a task never
 *   reaches into another task's checkout nested in the project folder; another
 *   task's base dir is NOT (S4): it is a plain folder of the same checkout, as any
 *   subfolder (project `shop`, task B's base dir `shop/payments` — a task at the
 *   project root edits `shop/payments/checkout.ts`). A folder that is also this
 *   task's own root (a subtask shares its parent's worktree) is the jail's to keep.
 * - A project (B1): its folder here first (a project process with no cwd starts
 *   there), then where its worktrees live (`worktreeBases`: the default
 *   `../<folder name>-workspaces`, and the hub's configured base), then every root of
 *   its tasks held here — the union of what its tasks may touch, so its git panel's
 *   Worktrees tab reaches every worktree of the project. Nothing of it without a
 *   folder here (the project is not placed on this computer). Another project's
 *   folder, and another project's tasks' roots, are carved out where they lie in
 *   those extra roots, never inside the project's own folder (S5, nested projects:
 *   project A `~/dev` holds project B `~/dev/web`).
 *
 * `foreign`: every root here that belongs to someone else — other tasks' folders,
 * other projects' folders (and their tasks'). A NEW root the request creates (`git
 * worktree add`'s target) may lie outside the scope, but never inside a foreign one.
 *
 * `projectFolder` resolves a project's folder on this computer (its placement);
 * `projectFolders` lists every project's folder here; `worktreeBases` names the
 * folders a project's worktrees are made in, from its folder here.
 */
export function scopeBounds(
  paths: {
    get(taskId: string): TaskPathRow | null
    others(taskId: string): { worktrees: string[]; baseDirs: string[] }
    ofProject?(projectId: string): { own: string[]; others: string[] }
  },
  scope:
    | { kind: 'task'; taskId: string; projectId: string | null }
    | { kind: 'project'; projectId: string },
  projectFolder: (projectId: string) => string | null,
  projectFolders: () => Array<{ projectId: string; path: string }> = () => [],
  worktreeBases: (projectId: string, folder: string) => string[] = () => []
): { roots: string[]; excluded: string[]; foreign: string[] } {
  const otherProjects = (projectId: string | null) =>
    projectFolders()
      .filter((p) => p.projectId !== projectId)
      .map((p) => p.path)
  if (scope.kind === 'project') {
    const folder = projectFolder(scope.projectId)
    const tasks = paths.ofProject?.(scope.projectId) ?? { own: [], others: [] }
    const foreign = [...new Set([...otherProjects(scope.projectId), ...tasks.others])]
    if (!folder) return { roots: [], excluded: [], foreign }
    const roots = [...new Set([folder, ...worktreeBases(scope.projectId, folder), ...tasks.own])]
    return {
      roots,
      // Someone else's root inside the project's extra roots; inside its own folder
      // everything stays the project's (S5).
      excluded: foreign.filter((r) => !isWithin(r, folder)),
      foreign
    }
  }
  const row = paths.get(scope.taskId)
  const projectId = row?.projectId ?? scope.projectId
  const folder = projectId ? projectFolder(projectId) : null
  const roots = [
    ...new Set(
      [row?.worktreePath ?? null, row?.baseDir ?? null, folder].filter(
        (r): r is string => r !== null
      )
    )
  ]
  const others = roots.length > 0 ? paths.others(scope.taskId) : { worktrees: [], baseDirs: [] }
  return {
    roots,
    excluded: others.worktrees,
    foreign: [...new Set([...others.worktrees, ...others.baseDirs, ...otherProjects(projectId)])]
  }
}
