import { assignNewWorktreeColors } from '../shared'

/**
 * Worktree colors per checkout: the panel lists a project's worktrees on its computer
 * (`worktrees.detectWorktrees`) and colors them here, in memory, stable for the
 * process's lifetime. A task's color is found client-side by matching its worktree
 * path (read from the computer, §9 Phase 7d) against that list; the hub never
 * learns which task a worktree belongs to.
 */
const registry = new Map<string, Map<string, string>>()

export function ensureColors(projectPath: string, nonMainPaths: string[]): Map<string, string> {
  const existing = registry.get(projectPath) ?? new Map<string, string>()
  const updated = assignNewWorktreeColors(nonMainPaths, existing)
  registry.set(projectPath, updated)
  return updated
}

export function getProjectColors(projectPath: string): ReadonlyMap<string, string> {
  return registry.get(projectPath) ?? new Map()
}

export function getColor(projectPath: string, worktreePath: string): string | undefined {
  return registry.get(projectPath)?.get(worktreePath)
}

export function __resetForTests(): void {
  registry.clear()
}
