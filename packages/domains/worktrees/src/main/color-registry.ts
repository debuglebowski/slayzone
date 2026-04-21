import { assignNewWorktreeColors } from '@slayzone/ui'
import { detectWorktrees } from './git-worktree'

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

/**
 * Returns project colors, running a worktree detection first if the registry is cold.
 * Used by cross-domain consumers (e.g. task handlers) that need color without triggering
 * the renderer detect IPC themselves.
 */
export async function ensureProjectColors(projectPath: string): Promise<ReadonlyMap<string, string>> {
  const existing = registry.get(projectPath)
  if (existing && existing.size > 0) return existing
  try {
    const detected = await detectWorktrees(projectPath)
    const nonMainPaths = detected.filter(d => !d.isMain).map(d => d.path)
    return ensureColors(projectPath, nonMainPaths)
  } catch {
    return new Map()
  }
}

export function __resetForTests(): void {
  registry.clear()
}
