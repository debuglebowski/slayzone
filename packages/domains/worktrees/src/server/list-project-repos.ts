/**
 * Repo discovery for the git panel: enumerates every git repo a task may want to view.
 *
 * Sources:
 * - Project root, if it is itself a git repo.
 * - Top-level child repos under projectPath (depth-capped + skip-list), for "wrapper folder" projects.
 * - Submodules of every git repo found above, recursively (via `git submodule status --recursive`).
 *
 * Results are flat with a `kind` discriminant + `parentPath` linkage. The viewer (RepoStrip)
 * groups submodules under their parent visually.
 *
 * NOT a worktree enumerator — `task.worktree_path` is overlaid by the caller via `taskBoundPath`.
 */

import { readdir, lstat as fsLstat } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { execGit } from './exec-async'
import { isGitRepo } from './git-worktree'
import type { RepoEntry, ListProjectReposOpts } from '../shared/types'

const MAX_CHILD_DEPTH = 3
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.svelte-kit',
  'target', '.git', '.venv', 'venv', '__pycache__', 'vendor', '.cache',
  '.turbo', 'out', 'coverage', '.parcel-cache', '.idea', '.vscode'
])

/**
 * Walk for git repos under root, capped at maxDepth, skipping known noise dirs.
 * Stops descending into a dir once it is identified as a git repo (we don't recurse
 * into a repo's working tree looking for nested repos — submodules handle that).
 */
async function walkForGitRoots(root: string, maxDepth: number): Promise<string[]> {
  const found: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries: string[]
    try { entries = await readdir(dir) } catch { return }

    await Promise.all(entries.map(async (entry) => {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) return
      const full = path.join(dir, entry)
      let s
      try { s = await fsLstat(full) } catch { return }
      // Skip symlinks entirely — they can form cycles (esp. on macOS user dirs)
      // and following them risks infinite recursion or counting the same repo twice.
      if (s.isSymbolicLink()) return
      if (!s.isDirectory()) return
      if (await isGitRepo(full)) {
        found.push(full)
        return // don't recurse into a repo
      }
      await walk(full, depth + 1)
    }))
  }

  await walk(root, 1)
  return found
}

/**
 * Parse `git submodule status --recursive` output.
 * Each line: " <sha> <path> [(branch)]" (leading char = ' ', '-', '+', or 'U').
 * Returns absolute paths (joined to the parent repo path).
 */
async function listSubmodules(repoPath: string): Promise<string[]> {
  if (!existsSync(path.join(repoPath, '.gitmodules'))) return []
  let out: string
  try {
    out = await execGit(['submodule', 'status', '--recursive'], { cwd: repoPath })
  } catch {
    return []
  }
  const subs: string[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    // Skip the leading status char + sha, then take next token as path.
    // Format: "[ -+U]<sha> <path>[ (refname)]"
    const m = line.match(/^[\s\-+U][0-9a-f]+\s+(\S+)/)
    if (m) subs.push(path.join(repoPath, m[1]))
  }
  return subs
}

/** Cache key = projectPath. TTL short — only paid on tab focus / strip render. */
interface CacheEntry { repos: RepoEntry[]; expiresAt: number }
const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5_000
const CACHE_MAX = 50

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

export function invalidateProjectReposCache(projectPath?: string): void {
  if (projectPath) cache.delete(projectPath)
  else cache.clear()
}

export async function listProjectRepos(
  projectPath: string,
  opts: ListProjectReposOpts = {}
): Promise<RepoEntry[]> {
  const cached = cache.get(projectPath)
  if (cached && cached.expiresAt > Date.now()) {
    return reannotateTaskBound(cached.repos, opts.taskBoundPath ?? null)
  }

  const taskBoundPath = opts.taskBoundPath ?? null
  const rootIsGit = await isGitRepo(projectPath)

  // Top-level git roots: the project itself OR its children (mutually exclusive in practice).
  const topLevelRoots = rootIsGit
    ? [projectPath]
    : await walkForGitRoots(projectPath, MAX_CHILD_DEPTH)

  // For each top-level root, enumerate submodules (recursive).
  const entries: RepoEntry[] = []
  await Promise.all(topLevelRoots.map(async (rootPath) => {
    const kind = rootPath === projectPath ? 'project-root' : 'child-repo'
    const hasGm = existsSync(path.join(rootPath, '.gitmodules'))
    entries.push({
      path: rootPath,
      name: nameFor(projectPath, rootPath),
      kind,
      parentPath: null,
      isTaskBound: rootPath === taskBoundPath,
      hasGitmodules: hasGm
    })

    const subs = await listSubmodules(rootPath)
    for (const subPath of subs) {
      entries.push({
        path: subPath,
        name: nameFor(projectPath, subPath),
        kind: 'submodule',
        parentPath: rootPath,
        isTaskBound: subPath === taskBoundPath,
        hasGitmodules: existsSync(path.join(subPath, '.gitmodules'))
      })
    }
  }))

  // Stable order: roots first (alpha), then submodules grouped under their root (alpha).
  entries.sort((a, b) => {
    const aRoot = a.parentPath ?? a.path
    const bRoot = b.parentPath ?? b.path
    if (aRoot !== bRoot) return aRoot.localeCompare(bRoot)
    if (a.parentPath === null && b.parentPath !== null) return -1
    if (a.parentPath !== null && b.parentPath === null) return 1
    return a.path.localeCompare(b.path)
  })

  cache.set(projectPath, { repos: entries, expiresAt: Date.now() + CACHE_TTL_MS })
  evictStale()
  return entries
}

function nameFor(projectPath: string, repoPath: string): string {
  if (repoPath === projectPath) return path.basename(projectPath)
  const rel = path.relative(projectPath, repoPath)
  return rel || path.basename(repoPath)
}

/** Re-flag isTaskBound on cached entries without re-walking the filesystem. */
function reannotateTaskBound(entries: RepoEntry[], taskBoundPath: string | null): RepoEntry[] {
  return entries.map(e => e.isTaskBound === (e.path === taskBoundPath)
    ? e
    : { ...e, isTaskBound: e.path === taskBoundPath })
}
