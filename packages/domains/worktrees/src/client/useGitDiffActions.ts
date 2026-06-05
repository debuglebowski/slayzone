import { useCallback } from 'react'

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
  const handleBulkAction = useCallback(
    async (action: 'stageAll' | 'unstageAll') => {
      if (!targetPath) return
      try {
        if (action === 'stageAll') {
          await window.api.git.stageAll(targetPath)
        } else {
          await window.api.git.unstageAll(targetPath)
        }
        await refreshRef.current()
      } catch {
        // silently fail — next poll will correct state
      }
    },
    [targetPath, refreshRef]
  )

  const handleStageAction = useCallback(
    async (filePath: string, source: 'unstaged' | 'staged') => {
      if (!targetPath) return
      try {
        if (source === 'unstaged') {
          await window.api.git.stageFile(targetPath, filePath)
        } else {
          await window.api.git.unstageFile(targetPath, filePath)
        }
        await refreshRef.current()
      } catch {
        // silently fail — next poll will correct state
      }
    },
    [targetPath, refreshRef]
  )

  const handleDiscardFile = useCallback(
    async (filePath: string, untracked?: boolean) => {
      if (!targetPath) return
      try {
        await window.api.git.discardFile(targetPath, filePath, untracked)
        await refreshRef.current()
      } catch {
        // silently fail — next poll will correct state
      }
    },
    [targetPath, refreshRef]
  )

  const handleStageFolderAction = useCallback(
    async (folderPath: string, source: 'unstaged' | 'staged') => {
      if (!targetPath) return
      try {
        if (source === 'unstaged') {
          await window.api.git.stageFile(targetPath, folderPath)
        } else {
          await window.api.git.unstageFile(targetPath, folderPath)
        }
        await refreshRef.current()
      } catch {
        // silently fail — next poll will correct state
      }
    },
    [targetPath, refreshRef]
  )

  return { handleBulkAction, handleStageAction, handleDiscardFile, handleStageFolderAction }
}
