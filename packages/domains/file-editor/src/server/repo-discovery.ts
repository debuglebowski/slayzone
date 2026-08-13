/**
 * Enumerate the git repositories under a project directory.
 *
 * Moved here from `@slayzone/worktrees/server` because it has to run on the
 * machine that OWNS the directory. It drives `resolveRepoPath` → the terminal
 * cwd, the editor root, and the git panel, so running it on the hub while the
 * checkout lives on a computer resolves every one of those to the wrong place —
 * the same defect as the project-path probe, one layer further in.
 *
 * The walk is one call, not one per directory. A depth-3 recursive walk routed
 * directory-by-directory would be dozens of round-trips; this way the traversal
 * stays next to the disk and only the result crosses the wire.
 *
 * Pure `node:fs` + `git` exec, like the rest of this package's server half, so
 * the computer bundles it and hub-local and computer-routed execution run identical
 * code. `isTaskBound` is deliberately NOT computed here — it is viewer state
 * belonging to whoever asked, not a property of the disk.
 *
 * @module file-editor/server/repo-discovery
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'

export type DiscoveredRepoKind = 'project-root' | 'child-repo' | 'submodule'

export interface DiscoveredRepo {
  /** Absolute path on the machine that ran the discovery. */
  path: string
  /** Display name: relative-from-root, falling back to basename. */
  name: string
  kind: DiscoveredRepoKind
  /** Submodule → containing repo absolute path; null otherwise. */
  parentPath: string | null
  /** Has a `.gitmodules` file (cheap hint for the "init submodules" affordance). */
  hasGitmodules: boolean
}

export const DEFAULT_REPO_SCAN_DEPTH = 3

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'target',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  '.cache',
  '.turbo',
  'out',
  'coverage',
  '.parcel-cache',
  '.idea',
  '.vscode'
])

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

/** `git rev-parse --git-dir` succeeds ⇒ inside a work tree. */
export async function isGitRepoDir(dir: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--git-dir'], dir)
    return true
  } catch {
    return false
  }
}

/**
 * Walk for git repos under root, capped at maxDepth, skipping known noise dirs.
 * Stops descending once a directory is identified as a repo — nested repos inside
 * a work tree are submodules, which the submodule pass below enumerates properly.
 */
async function walkForGitRoots(root: string, maxDepth: number): Promise<string[]> {
  const found: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }

    await Promise.all(
      entries.map(async (entry) => {
        if (SKIP_DIRS.has(entry) || entry.startsWith('.')) return
        const full = path.join(dir, entry)
        let s
        try {
          s = await lstat(full)
        } catch {
          return
        }
        // Symlinks are skipped entirely — they can form cycles (especially in
        // macOS user dirs), and following them risks infinite recursion or
        // counting the same repo twice.
        if (s.isSymbolicLink()) return
        if (!s.isDirectory()) return
        if (await isGitRepoDir(full)) {
          found.push(full)
          return
        }
        await walk(full, depth + 1)
      })
    )
  }

  await walk(root, 1)
  return found
}

/**
 * Parse `git submodule status --recursive`.
 * Each line: `[ -+U]<sha> <path>[ (refname)]`. Returns absolute paths.
 */
async function listSubmodules(repoPath: string): Promise<string[]> {
  if (!existsSync(path.join(repoPath, '.gitmodules'))) return []
  let out: string
  try {
    out = await git(['submodule', 'status', '--recursive'], repoPath)
  } catch {
    return []
  }
  const subs: string[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const m = line.match(/^[\s\-+U][0-9a-f]+\s+(\S+)/)
    if (m) subs.push(path.join(repoPath, m[1]))
  }
  return subs
}

function nameFor(rootPath: string, repoPath: string): string {
  if (repoPath === rootPath) return path.basename(rootPath)
  return path.relative(rootPath, repoPath) || path.basename(repoPath)
}

/**
 * Every repo a task under `rootPath` may want to view: the project root itself
 * if it is a repo, else its top-level children ("wrapper folder" projects), plus
 * the submodules of each, recursively.
 */
export async function discoverRepos(
  rootPath: string,
  maxDepth: number = DEFAULT_REPO_SCAN_DEPTH
): Promise<DiscoveredRepo[]> {
  const rootIsGit = await isGitRepoDir(rootPath)
  const topLevelRoots = rootIsGit ? [rootPath] : await walkForGitRoots(rootPath, maxDepth)

  const entries: DiscoveredRepo[] = []
  await Promise.all(
    topLevelRoots.map(async (repoPath) => {
      entries.push({
        path: repoPath,
        name: nameFor(rootPath, repoPath),
        kind: repoPath === rootPath ? 'project-root' : 'child-repo',
        parentPath: null,
        hasGitmodules: existsSync(path.join(repoPath, '.gitmodules'))
      })
      for (const subPath of await listSubmodules(repoPath)) {
        entries.push({
          path: subPath,
          name: nameFor(rootPath, subPath),
          kind: 'submodule',
          parentPath: repoPath,
          hasGitmodules: existsSync(path.join(subPath, '.gitmodules'))
        })
      }
    })
  )

  // Stable order: roots first (alpha), then submodules grouped under their root.
  entries.sort((a, b) => {
    const aRoot = a.parentPath ?? a.path
    const bRoot = b.parentPath ?? b.path
    if (aRoot !== bRoot) return aRoot.localeCompare(bRoot)
    if (a.parentPath === null && b.parentPath !== null) return -1
    if (a.parentPath !== null && b.parentPath === null) return 1
    return a.path.localeCompare(b.path)
  })
  return entries
}
