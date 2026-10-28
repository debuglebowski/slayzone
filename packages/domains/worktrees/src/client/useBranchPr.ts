import { useQuery } from '@tanstack/react-query'
import { useTRPC } from './trpc'
import type { Task } from '@slayzone/task-contracts'

const POLL_MS = 30_000

/** The checkout a task's branch lives in: its worktree, else its base dir, else the project. */
export function taskCheckoutPath(task: Task, projectPath: string | null): string | null {
  return task.worktree_path ?? task.base_dir ?? projectPath
}

/**
 * The PR gh resolves for the task's checked-out branch. Only consulted while the
 * task has no manually linked `pr_url` — a manual link is the override. The one
 * source for every consumer (tab visibility, PR tab, General header): one shared
 * query key, so they dedupe to one `gh pr view` per checkout + branch.
 *
 * Keyed by branch so a branch switch is a fresh key, never the old branch's PR.
 * A failed gh call (auth, network) throws server-side; react-query then keeps the
 * last PR it had instead of blinking it away.
 */
export function useBranchPr({
  task,
  projectPath,
  enabled
}: {
  task: Task | null | undefined
  projectPath: string | null
  enabled: boolean
}) {
  const trpc = useTRPC()
  const checkoutPath = task ? taskCheckoutPath(task, projectPath) : null
  const active = enabled && !!task && !task.pr_url && !!checkoutPath
  const branchQuery = useQuery(
    trpc.worktrees.getCurrentBranch.queryOptions(
      { path: checkoutPath ?? '' },
      { enabled: active, refetchInterval: POLL_MS }
    )
  )
  const branch = branchQuery.data ?? null
  const prQuery = useQuery(
    trpc.worktrees.getPrForCheckout.queryOptions(
      { repoPath: checkoutPath ?? '', branch: branch ?? '' },
      {
        enabled: active && !!branch,
        refetchInterval: POLL_MS,
        staleTime: 15_000
      }
    )
  )
  const pr = active && branch ? (prQuery.data ?? null) : null
  return {
    pr,
    checkoutPath,
    loading: branchQuery.isLoading || prQuery.isLoading,
    refetch: prQuery.refetch
  }
}
