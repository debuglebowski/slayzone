import { useCallback } from 'react'
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
  // Merge-mode: commit and continue merge
  const handleCommitAndContinueMerge = useCallback(async () => {
    if (!task || !onUpdateTask || !onTaskUpdated) return
    const targetPath = task.worktree_path ?? projectPath
    if (!targetPath) return

    await window.api.git.stageAll(targetPath)
    await window.api.git.commitFiles(targetPath, 'WIP: changes before merge')

    const sourceBranch = await window.api.git.getCurrentBranch(task.worktree_path!)
    if (!sourceBranch) throw new Error('Cannot merge: detached HEAD in worktree')

    const result = await window.api.git.mergeWithAI(
      projectPath!,
      task.worktree_path!,
      task.worktree_parent_branch!,
      sourceBranch
    )

    if (result.success) {
      const updated = await onUpdateTask({
        id: task.id,
        status: completedStatus,
        mergeState: null,
        mergeContext: null
      })
      onTaskUpdated(updated)
    } else if (result.resolving) {
      const ctx = await window.api.git.getMergeContext(projectPath!)
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
  }, [task, projectPath, completedStatus, onUpdateTask, onTaskUpdated])

  const handleAbortMerge = useCallback(async () => {
    if (!task || !onUpdateTask || !onTaskUpdated) return
    if (projectPath) {
      try {
        await window.api.git.abortMerge(projectPath)
      } catch {
        /* already aborted */
      }
    }
    const updated = await onUpdateTask({ id: task.id, mergeState: null, mergeContext: null })
    onTaskUpdated(updated)
  }, [task, projectPath, onUpdateTask, onTaskUpdated])

  return { handleCommitAndContinueMerge, handleAbortMerge }
}
