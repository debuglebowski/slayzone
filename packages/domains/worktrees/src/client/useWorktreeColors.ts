/**
 * Each task's worktree colour (sidebar pill, tab tint), worked out in the client
 * (robustness plan §9, P0; Phase 7d): the task's worktree path comes from its
 * computer (`useTaskWorktreePaths`), its project's coloured worktree list from that
 * project's computer (`worktrees.detectWorktrees`, coloured by the hub's in-memory
 * registry exactly as before) — and the two are matched here, so the colours stay
 * what they were while the hub never learns which task a worktree belongs to.
 *
 * A task whose path or list is not in yet (loading, computer away) has no colour:
 * the neutral pill. Never throws during render.
 *
 * @module worktrees/client/useWorktreeColors
 */
import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { Task } from '@slayzone/task-contracts'
import type { Project } from '@slayzone/projects-contracts'
import { taskProjectRoot } from '@slayzone/projects-contracts/placements'
import { useTaskWorktreePaths } from '@slayzone/task/client/useTaskPath'
import { getClientForHub, getHubIdForProject } from '@slayzone/transport/client'
import { useTRPCClient } from './trpc'
import type { DetectedWorktree } from '../shared/types'

/** The root of every worktree-colour query key (the app shell refetches it on a computer connect). */
export const WORKTREE_COLORS_QUERY_ROOT = ['worktree-colors'] as const

interface DetectClient {
  worktrees: {
    detectWorktrees: {
      query(input: {
        repoPath: string
        target: { projectId: string }
      }): Promise<Array<DetectedWorktree & { color?: string }>>
    }
  }
}

export function useWorktreeColors(
  tasks: readonly Task[],
  projects: readonly Project[]
): ReadonlyMap<string, string> {
  const ambient = useTRPCClient()
  const withWorktree = tasks.filter((t) => t.has_worktree && !t.archived_at)
  const paths = useTaskWorktreePaths(withWorktree)
  // One coloured list per project folder a worktree task's work runs in.
  const roots = new Map<string, { projectId: string; root: string }>()
  for (const task of withWorktree) {
    const project = projects.find((p) => p.id === task.project_id)
    const root = taskProjectRoot(task, project)
    if (root && project) roots.set(`${project.id}\0${root}`, { projectId: project.id, root })
  }
  const lists = [...roots.values()]
  const results = useQueries({
    queries: lists.map(({ projectId, root }) => ({
      queryKey: [...WORKTREE_COLORS_QUERY_ROOT, projectId, root],
      queryFn: () =>
        (
          getClientForHub(
            getHubIdForProject(projectId),
            ambient as never
          ) as unknown as DetectClient
        ).worktrees.detectWorktrees.query({ repoPath: root, target: { projectId } }),
      staleTime: 60_000,
      retry: false
    }))
  })
  const colorByPath = new Map<string, string>()
  results.forEach((r) => {
    for (const wt of r.data ?? []) if (wt.color) colorByPath.set(wt.path, wt.color)
  })
  const entries: Array<[string, string]> = []
  for (const task of withWorktree) {
    const path = paths.get(task.id)
    const color = path ? colorByPath.get(path) : undefined
    if (color) entries.push([task.id, color])
  }
  // Same colours → the same Map (consumers memoize on it).
  const signature = JSON.stringify(entries)
  return useMemo(() => new Map<string, string>(JSON.parse(signature)), [signature])
}
