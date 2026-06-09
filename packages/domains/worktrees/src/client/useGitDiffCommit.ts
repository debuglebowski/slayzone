import { useCallback, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'

interface UseGitDiffCommitParams {
  targetPath: string | null
  stagedCount: number
  refreshRef: React.RefObject<() => void>
}

/**
 * Commit message + in-flight state and the commit handler. commitError is owned
 * here (surfaced together with the fetch error by the panel); the merge-mode
 * "commit & continue" button reuses setCommitting / setCommitError.
 */
export function useGitDiffCommit({ targetPath, stagedCount, refreshRef }: UseGitDiffCommitParams) {
  const trpc = useTRPC()
  const commitFilesMutation = useMutation(trpc.worktrees.commitFiles.mutationOptions())
  const [commitError, setCommitError] = useState<string | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [committing, setCommitting] = useState(false)

  const handleCommit = useCallback(async () => {
    if (!targetPath || !commitMessage.trim() || stagedCount === 0) return
    setCommitting(true)
    try {
      await commitFilesMutation.mutateAsync({ repoPath: targetPath, message: commitMessage.trim() })
      setCommitMessage('')
      await refreshRef.current()
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : String(err))
    } finally {
      setCommitting(false)
    }
  }, [targetPath, commitMessage, stagedCount, refreshRef])

  return {
    commitMessage,
    setCommitMessage,
    committing,
    setCommitting,
    commitError,
    setCommitError,
    handleCommit
  }
}
