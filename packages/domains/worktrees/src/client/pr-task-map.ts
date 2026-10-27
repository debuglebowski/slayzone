import type { Task } from '@slayzone/task/shared'
import type { DetectedWorktree, GhPullRequest } from '../shared/types'

/**
 * PR url → the task it belongs to. A manually linked `pr_url` wins; otherwise a
 * task whose worktree has the PR's head branch checked out claims it — the same
 * rule the task's own Git panel uses. Fork PRs never match by branch: their head
 * name says nothing about which local branch they came from. A PR claimed by more
 * than one task (by branch) is left unmatched rather than guessed.
 */
export function mapPrsToTasks(
  prs: GhPullRequest[],
  tasks: Task[],
  worktrees: DetectedWorktree[]
): Map<string, Task> {
  const map = new Map<string, Task>()
  for (const task of tasks) {
    if (task.pr_url) map.set(task.pr_url, task)
  }

  const branchByPath = new Map(worktrees.map((w) => [w.path, w.branch]))
  const tasksByBranch = new Map<string, Task[]>()
  for (const task of tasks) {
    if (task.pr_url || !task.worktree_path) continue
    const branch = branchByPath.get(task.worktree_path)
    if (!branch) continue
    tasksByBranch.set(branch, [...(tasksByBranch.get(branch) ?? []), task])
  }

  for (const pr of prs) {
    if (map.has(pr.url) || pr.isCrossRepository) continue
    const claimants = tasksByBranch.get(pr.headRefName)
    if (claimants?.length === 1) map.set(pr.url, claimants[0])
  }
  return map
}
