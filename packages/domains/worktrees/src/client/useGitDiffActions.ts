import { useCallback } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'

interface UseGitDiffActionsParams {
  targetPath: string | null
  refreshRef: React.RefObject<() => void>
}

/**
 * Git mutation handlers (stage / unstage / discard, per-file, per-folder, and
 * bulk). Each refreshes the snapshot after mutating; failures are swallowed
 * because the next poll corrects state.
 */
export function useGitDiffActions({ targetPath, refreshRef }: UseGitDiffActionsParams) {
  const trpc = useTRPC()
  const stageAllMutation = useMutation(trpc.worktrees.stageAll.mutationOptions())
  const unstageAllMutation = useMutation(trpc.worktrees.unstageAll.mutationOptions())
  const stageFileMutation = useMutation(trpc.worktrees.stageFile.mutationOptions())
  const unstageFileMutation = useMutation(trpc.worktrees.unstageFile.mutationOptions())
  const discardFileMutation = useMutation(trpc.worktrees.discardFile.mutationOptions())

  const handleBulkAction = useCallback(
    async (action: 'stageAll' | 'unstageAll') => {
      if (!targetPath) return
      try {
        if (action === 'stageAll') {
          await stageAllMutation.mutateAsync({ path: targetPath })
        } else {
          await unstageAllMutation.mutateAsync({ path: targetPath })
        }
        await refreshRef.current()
      } catch {
        // silently fail — next poll will correct state
      }
    },
    [targetPath, refreshRef, stageAllMutation, unstageAllMutation]
  )

  const handleStageAction = useCallback(
    async (filePath: string, source: 'unstaged' | 'staged') => {
      if (!targetPath) return
      try {
        if (source === 'unstaged') {
          await stageFileMutation.mutateAsync({ path: targetPath, filePath })
        } else {
          await unstageFileMutation.mutateAsync({ path: targetPath, filePath })
        }
        await refreshRef.current()
      } catch {
        // silently fail — next poll will correct state
      }
    },
    [targetPath, refreshRef, stageFileMutation, unstageFileMutation]
  )

  const handleDiscardFile = useCallback(
    async (filePath: string, untracked?: boolean) => {
      if (!targetPath) return
      try {
        await discardFileMutation.mutateAsync({ path: targetPath, filePath, untracked })
        await refreshRef.current()
      } catch {
        // silently fail — next poll will correct state
      }
    },
    [targetPath, refreshRef, discardFileMutation]
  )

  const handleStageFolderAction = useCallback(
    async (folderPath: string, source: 'unstaged' | 'staged') => {
      if (!targetPath) return
      try {
        if (source === 'unstaged') {
          await stageFileMutation.mutateAsync({ path: targetPath, filePath: folderPath })
        } else {
          await unstageFileMutation.mutateAsync({ path: targetPath, filePath: folderPath })
        }
        await refreshRef.current()
      } catch {
        // silently fail — next poll will correct state
      }
    },
    [targetPath, refreshRef, stageFileMutation, unstageFileMutation]
  )

  return { handleBulkAction, handleStageAction, handleDiscardFile, handleStageFolderAction }
}
