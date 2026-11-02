import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTRPCClient } from './trpc'

type TrpcClient = ReturnType<typeof useTRPCClient>

/**
 * Whether the slay setup banner should show; `null` = dismissed or cancelled (leave
 * the banner state alone). Outside the hook: the React Compiler skips a function
 * with value blocks inside try/catch.
 */
async function shouldShowSlayNudge(
  trpcClient: TrpcClient,
  ids: { taskId: string; projectId: string; projectPath: string },
  isCancelled: () => boolean
): Promise<boolean | null> {
  try {
    const dismissed = await trpcClient.settings.get.query({
      key: `slay_nudge_dismissed:${ids.projectId}`
    })
    if (isCancelled() || dismissed === '1') return null
    const configured = await trpcClient.aiConfig.checkSlayConfigured.query(ids)
    return !configured
  } catch {
    // An unreachable computer cannot tell us setup is missing. Never prompt
    // based on hub files or a previous task's result.
    return false
  }
}

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
    if (taskId && projectId && projectPath) {
      void shouldShowSlayNudge(
        trpcClient,
        { taskId, projectId, projectPath },
        () => cancelled
      ).then((show) => {
        if (!cancelled && show !== null) setBanner({ target, show })
      })
    }
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
