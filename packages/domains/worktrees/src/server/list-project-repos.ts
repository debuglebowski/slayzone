/**
 * Repo discovery for the git panel, addressed by COMPUTER.
 *
 * The walk itself moved to `@slayzone/file-editor/server` (`discoverRepos`) so it
 * can execute on the machine that owns the directory. It used to run here, in the
 * hub, against the hub's own disk — which resolved the terminal cwd, the editor
 * root, and the git panel to the wrong place for any project living on a computer.
 * What stays here is the part that is genuinely hub-side: the cache and the
 * task-bound annotation.
 *
 * NOT a worktree enumerator — `task.worktree_path` is overlaid by the caller via
 * `taskBoundPath`.
 */

import type { WorkspaceFsAdapters } from '@slayzone/file-editor/server'
import path from 'path'
import type { RepoEntry, ListProjectReposOpts } from '../shared/types'

/**
 * Cache key is (computer, path), NOT path alone.
 *
 * Two computers routinely hold the same absolute path — `/home/user/dev/app` is
 * the common case, not an exotic one — and a path-keyed cache would serve one
 * machine's repo layout as the other's. Short TTL; only paid on tab focus /
 * strip render.
 */
interface CacheEntry {
  repos: RepoEntry[]
  expiresAt: number
}
const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5_000
const CACHE_MAX = 50

const cacheKey = (computerId: string | null, projectPath: string): string =>
  `${computerId ?? 'local'}\u0000${projectPath}`

function evictStale(): void {
  if (cache.size <= CACHE_MAX) return
  const now = Date.now()
  for (const [k, v] of cache) {
    if (v.expiresAt < now) cache.delete(k)
  }
  if (cache.size > CACHE_MAX) {
    const sorted = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    for (let i = 0; i < sorted.length - CACHE_MAX; i++) cache.delete(sorted[i][0])
  }
}

/** Drop cached layouts. Without a path, drops everything (all computers). */
export function invalidateProjectReposCache(projectPath?: string): void {
  if (!projectPath) {
    cache.clear()
    return
  }
  for (const k of [...cache.keys()]) {
    if (k.endsWith(`\u0000${projectPath}`)) cache.delete(k)
  }
}

export async function listProjectRepos(
  fs: WorkspaceFsAdapters,
  computerId: string | null,
  projectPath: string,
  opts: ListProjectReposOpts = {}
): Promise<RepoEntry[]> {
  const key = cacheKey(computerId, projectPath)
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return reannotateTaskBound(cached.repos, opts.taskBoundPath ?? null)
  }

  const taskBoundPath = opts.taskBoundPath ?? null
  const discovered = await fs.discoverRepos(computerId, projectPath)
  const entries: RepoEntry[] = discovered.map((d) => ({
    path: d.path,
    name: d.name,
    kind: d.kind,
    parentPath: d.parentPath,
    isTaskBound: d.path === taskBoundPath,
    hasGitmodules: d.hasGitmodules
  }))

  cache.set(key, { repos: entries, expiresAt: Date.now() + CACHE_TTL_MS })
  evictStale()
  return entries
}

/**
 * Immediate child git repos of a project directory ("wrapper folder" projects).
 *
 * A projection of the same discovery, so the two can no longer disagree about
 * what counts as a repo — they were separate walks with subtly different rules.
 */
export async function detectChildRepos(
  fs: WorkspaceFsAdapters,
  computerId: string | null,
  projectPath: string
): Promise<{ name: string; path: string }[]> {
  const repos = await listProjectRepos(fs, computerId, projectPath)
  // A project that IS a repo has no child repos — multi-repo mode is off.
  if (repos.some((r) => r.kind === 'project-root')) return []
  return repos
    .filter((r) => r.kind === 'child-repo')
    .map((r) => ({ name: path.basename(r.path), path: r.path }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Re-flag isTaskBound on cached entries without re-walking the filesystem. */
function reannotateTaskBound(entries: RepoEntry[], taskBoundPath: string | null): RepoEntry[] {
  return entries.map((e) =>
    e.isTaskBound === (e.path === taskBoundPath)
      ? e
      : { ...e, isTaskBound: e.path === taskBoundPath }
  )
}
