import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTRPCClient } from './trpc'

interface UseSlayNudgeOptions {
  computerId?: string | null
  taskId: string | null
  projectId: string | null
  projectPath: string | null
}

export function useSlayNudge({ computerId, taskId, projectId, projectPath }: UseSlayNudgeOptions) {
  const trpcClient = useTRPCClient()
  const target = useMemo(
    () => ({ computerId, taskId, projectId, projectPath, trpcClient }),
    [computerId, taskId, projectId, projectPath, trpcClient]
  )
  const [banner, setBanner] = useState<{ target: typeof target; show: boolean } | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      if (!taskId || !projectId || !projectPath) return
      try {
        const dismissed = await trpcClient.settings.get.query({
          key: `slay_nudge_dismissed:${projectId}`
        })
        if (cancelled || dismissed === '1') return
        const configured = await trpcClient.aiConfig.checkSlayConfigured.query({
          taskId,
          projectId,
          projectPath
        })
        if (!cancelled) setBanner({ target, show: !configured })
      } catch {
        // An unreachable computer cannot tell us setup is missing. Never prompt
        // based on hub files or a previous task's result.
        if (!cancelled) setBanner({ target, show: false })
      }
    }
    void check()
    return () => {
      cancelled = true
    }
  }, [target, taskId, projectId, projectPath, trpcClient, revision])

  const dismiss = () => {
    setBanner({ target, show: false })
    if (projectId)
      void trpcClient.settings.set.mutate({ key: `slay_nudge_dismissed:${projectId}`, value: '1' })
  }
  const recheck = useCallback(() => {
    setBanner(null)
    setRevision((value) => value + 1)
  }, [])

  return { showBanner: banner?.target === target && banner.show, dismiss, recheck }
}
