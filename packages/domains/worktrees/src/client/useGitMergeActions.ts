import { useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { Task, UpdateTaskInput } from '@slayzone/task/shared'

export function useGitMergeActions({
  task,
  projectPath,
  completedStatus,
  onUpdateTask,
  onTaskUpdated
}: {
  task?: Task | null
  projectPath: string | null
  completedStatus: string
  onUpdateTask?: (data: UpdateTaskInput) => Promise<Task>
  onTaskUpdated?: (task: Task) => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const stageAllMutation = useMutation(trpc.worktrees.stageAll.mutationOptions())
  const commitFilesMutation = useMutation(trpc.worktrees.commitFiles.mutationOptions())
  const mergeWithAiMutation = useMutation(trpc.worktrees.mergeWithAI.mutationOptions())
  const abortMergeMutation = useMutation(trpc.worktrees.abortMerge.mutationOptions())

  // Merge-mode: commit and continue merge
  const handleCommitAndContinueMerge = useCallback(async () => {
    if (!task || !onUpdateTask || !onTaskUpdated) return
    const targetPath = task.worktree_path ?? projectPath
    if (!targetPath) return

    await stageAllMutation.mutateAsync({ path: targetPath })
    await commitFilesMutation.mutateAsync({
      repoPath: targetPath,
      message: 'WIP: changes before merge'
    })

    const sourceBranch = await queryClient.fetchQuery(
      trpc.worktrees.getCurrentBranch.queryOptions({ path: task.worktree_path! })
    )
    if (!sourceBranch) throw new Error('Cannot merge: detached HEAD in worktree')

    const result = await mergeWithAiMutation.mutateAsync({
      projectPath: projectPath!,
      worktreePath: task.worktree_path!,
      parentBranch: task.worktree_parent_branch!,
      sourceBranch
    })

    if (result.success) {
      const updated = await onUpdateTask({
        id: task.id,
        status: completedStatus,
        mergeState: null,
        mergeContext: null
      })
      onTaskUpdated(updated)
    } else if (result.resolving) {
      const ctx = await queryClient.fetchQuery(
        trpc.worktrees.getMergeContext.queryOptions({ repoPath: projectPath! })
      )
      const updated = await onUpdateTask({
        id: task.id,
        mergeState: 'conflicts',
        mergeContext: ctx ?? {
          type: 'merge',
          sourceBranch,
          targetBranch: task.worktree_parent_branch!
        }
      })
      onTaskUpdated(updated)
    } else if (result.error) {
      throw new Error(result.error)
    }
  }, [
    task,
    projectPath,
    completedStatus,
    onUpdateTask,
    onTaskUpdated,
    queryClient,
    trpc,
    stageAllMutation,
    commitFilesMutation,
    mergeWithAiMutation
  ])

  const handleAbortMerge = useCallback(async () => {
    if (!task || !onUpdateTask || !onTaskUpdated) return
    if (projectPath) {
      try {
        await abortMergeMutation.mutateAsync({ path: projectPath })
      } catch {
        /* already aborted */
      }
    }
    const updated = await onUpdateTask({ id: task.id, mergeState: null, mergeContext: null })
    onTaskUpdated(updated)
  }, [task, projectPath, onUpdateTask, onTaskUpdated, abortMergeMutation])

  return { handleCommitAndContinueMerge, handleAbortMerge }
}
