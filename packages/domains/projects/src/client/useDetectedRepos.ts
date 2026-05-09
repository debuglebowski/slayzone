import { useState, useEffect } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import type { DetectedRepo } from '@slayzone/projects/shared'

export function useDetectedRepos(projectPath: string | null): DetectedRepo[] {
  const trpcClient = useTRPCClient()
  const [repos, setRepos] = useState<DetectedRepo[]>([])
  useEffect(() => {
    if (!projectPath) { setRepos([]); return }
    trpcClient.worktrees.detectChildRepos.query({ projectPath: projectPath }).then(setRepos).catch(() => setRepos([]))
  }, [projectPath, trpcClient])
  return repos
}
