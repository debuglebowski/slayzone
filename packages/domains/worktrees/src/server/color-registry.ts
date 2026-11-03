import { assignNewWorktreeColors } from '../shared'
import { isHubSwitchedOffError } from '@slayzone/platform/hub-switch-refusal'
import type { DetectedWorktree } from '../shared/types'

/** Lists a checkout's worktrees — on the hub, the routed `listWorktrees` op. */
export type WorktreeDetector = (projectPath: string) => Promise<DetectedWorktree[]>
let detector: WorktreeDetector | null = null

/** Wired by the hub's composition; none = colors stay empty. */
export function setWorktreeColorDetector(next: WorktreeDetector | null): void {
  detector = next
}

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
 *
 * Key-presence (not size>0) gates re-detection: projects with no non-main worktrees AND
 * projects whose detection failed (non-git paths, permission errors) register an empty
 * Map sentinel, preventing repeated FS calls on every task fetch. The WorktreesTab IPC
 * handler path still updates the registry on every poll when the panel is open, so real
 * changes (e.g. user runs `git init` later) are picked up there.
 */
export async function ensureProjectColors(
  projectPath: string,
  detect: WorktreeDetector | null = detector
): Promise<ReadonlyMap<string, string>> {
  const existing = registry.get(projectPath)
  if (existing !== undefined) return existing
  if (!detect) return new Map()
  try {
    const detected = await detect(projectPath)
    const nonMainPaths = detected.filter((d) => !d.isMain).map((d) => d.path)
    return ensureColors(projectPath, nonMainPaths)
  } catch (err) {
    // No computer yet: not a property of the project — detect again next time.
    if (isHubSwitchedOffError(err)) return new Map()
    const empty = new Map<string, string>()
    registry.set(projectPath, empty)
    return empty
  }
}

export function __resetForTests(): void {
  registry.clear()
}
