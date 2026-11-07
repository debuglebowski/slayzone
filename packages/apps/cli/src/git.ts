import { spawnSync } from 'child_process'
import { gitCommand } from '@slayzone/platform/resolve-command'
import { existsSync, readdirSync, realpathSync } from 'fs'
import path from 'path'

function canonical(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

function git(args: string[], cwd: string): { stdout: string; status: number } {
  const r = spawnSync(gitCommand(), args, { cwd, encoding: 'utf8' })
  return { stdout: (r.stdout ?? '').trim(), status: r.status ?? 1 }
}

export function isGitRepo(p: string): boolean {
  if (!existsSync(p)) return false
  return git(['rev-parse', '--git-dir'], p).status === 0
}

export function getCurrentBranch(repoPath: string): string | null {
  const r = git(['branch', '--show-current'], repoPath)
  if (r.status !== 0) return null
  return r.stdout || null
}

export interface WorktreeEntry {
  path: string
}

export function listWorktrees(repoPath: string): WorktreeEntry[] {
  const r = git(['worktree', 'list', '--porcelain'], repoPath)
  if (r.status !== 0) return []
  const entries: WorktreeEntry[] = []
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) entries.push({ path: line.slice(9) })
  }
  return entries
}

/** Candidate source repos under a project root: the root if it's a git repo,
 *  else immediate subdirs that are git repos. Submodules + deep nesting out of scope. */
export function listProjectRepoCandidates(projectPath: string): string[] {
  if (isGitRepo(projectPath)) return [projectPath]
  if (!existsSync(projectPath)) return []
  const out: string[] = []
  for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    const child = path.join(projectPath, entry.name)
    if (isGitRepo(child)) out.push(child)
  }
  return out
}

/** Find which repo under projectPath owns `worktreePath` (via `git worktree list`).
 *  Returns the source repo's main worktree dir, or null if no repo claims the path. */
export function findSourceRepo(projectPath: string, worktreePath: string): string | null {
  const target = canonical(worktreePath)
  for (const repo of listProjectRepoCandidates(projectPath)) {
    for (const wt of listWorktrees(repo)) {
      if (canonical(wt.path) === target) return repo
    }
  }
  return null
}
