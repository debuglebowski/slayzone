import { useCallback } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from './trpc'

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
  const { mutateAsync: stageAll } = useMutation(trpc.worktrees.stageAll.mutationOptions())
  const { mutateAsync: unstageAll } = useMutation(trpc.worktrees.unstageAll.mutationOptions())
  const { mutateAsync: stageFile } = useMutation(trpc.worktrees.stageFile.mutationOptions())
  const { mutateAsync: unstageFile } = useMutation(trpc.worktrees.unstageFile.mutationOptions())
  const { mutateAsync: discardFile } = useMutation(trpc.worktrees.discardFile.mutationOptions())

  const handleBulkAction = useCallback(
    async (action: 'stageAll' | 'unstageAll') => {
      if (!targetPath) return
      try {
        if (action === 'stageAll') {
          await stageAll({ path: targetPath })
        } else {
          await unstageAll({ path: targetPath })
        }
        await refreshRef.current()
      } catch {
        // silently fail — next poll will correct state
      }
    },
    [targetPath, refreshRef, stageAll, unstageAll]
  )

  const handleStageAction = useCallback(
    async (filePath: string, source: 'unstaged' | 'staged') => {
      if (!targetPath) return
      try {
        if (source === 'unstaged') {
          await stageFile({ path: targetPath, filePath })
        } else {
          await unstageFile({ path: targetPath, filePath })
        }
        await refreshRef.current()
      } catch {
        // silently fail — next poll will correct state
      }
    },
    [targetPath, refreshRef, stageFile, unstageFile]
  )

  const handleDiscardFile = useCallback(
    async (filePath: string, untracked?: boolean) => {
      if (!targetPath) return
      try {
        await discardFile({ path: targetPath, filePath, untracked })
        await refreshRef.current()
      } catch {
        // silently fail — next poll will correct state
      }
    },
    [targetPath, refreshRef, discardFile]
  )

  const handleStageFolderAction = useCallback(
    async (folderPath: string, source: 'unstaged' | 'staged') => {
      if (!targetPath) return
      try {
        if (source === 'unstaged') {
          await stageFile({ path: targetPath, filePath: folderPath })
        } else {
          await unstageFile({ path: targetPath, filePath: folderPath })
        }
        await refreshRef.current()
      } catch {
        // silently fail — next poll will correct state
      }
    },
    [targetPath, refreshRef, stageFile, unstageFile]
  )

  return { handleBulkAction, handleStageAction, handleDiscardFile, handleStageFolderAction }
}
