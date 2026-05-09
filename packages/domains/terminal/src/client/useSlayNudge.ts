import { useState, useEffect, useCallback } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'

interface UseSlayNudgeOptions {
  projectId: string | null
  projectPath: string | null
}

export function useSlayNudge({ projectId, projectPath }: UseSlayNudgeOptions) {
  const trpcClient = useTRPCClient()
  const [dismissed, setDismissed] = useState(true)
  const [slayConfigured, setSlayConfigured] = useState(true)

  useEffect(() => {
    if (!projectId) return
    trpcClient.settings.get.query({ key: `slay_nudge_dismissed:${projectId}` }).then((val) => {
      setDismissed(val === '1')
    })
  }, [projectId, trpcClient])

  useEffect(() => {
    if (!projectPath || dismissed) return
    trpcClient.aiConfig.checkSlayConfigured.query({ projectPath }).then((configured) => {
      setSlayConfigured(configured)
    })
  }, [projectPath, dismissed, trpcClient])

  const dismiss = () => {
    if (!projectId) return
    setDismissed(true)
    trpcClient.settings.set.mutate({ key: `slay_nudge_dismissed:${projectId}`, value: '1' })
  }

  const recheck = useCallback(() => {
    if (!projectPath) return
    trpcClient.aiConfig.checkSlayConfigured.query({ projectPath }).then((configured) => {
      setSlayConfigured(configured)
      if (configured) setDismissed(true)
    })
  }, [projectPath, trpcClient])

  return {
    showBanner: !dismissed && !slayConfigured,
    dismiss,
    recheck,
  }
}
