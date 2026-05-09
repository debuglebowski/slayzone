import { useEffect, useState, useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'

interface UseSlayNudgeOptions {
  projectId: string | null
  projectPath: string | null
}

export function useSlayNudge({ projectId, projectPath }: UseSlayNudgeOptions) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [dismissed, setDismissed] = useState(true)

  const dismissedQuery = useQuery({
    ...trpc.settings.get.queryOptions({ key: `slay_nudge_dismissed:${projectId ?? ''}` }),
    enabled: !!projectId,
  })
  const slayConfiguredQuery = useQuery({
    ...trpc.aiConfig.checkSlayConfigured.queryOptions({ projectPath: projectPath ?? '' }),
    enabled: !!projectPath && !dismissed,
  })
  const setSettingMutation = useMutation(trpc.settings.set.mutationOptions())

  // Hydrate dismissed from cache
  useEffect(() => {
    if (dismissedQuery.data !== undefined) {
      setDismissed(dismissedQuery.data === '1')
    }
  }, [dismissedQuery.data])

  const slayConfigured = slayConfiguredQuery.data ?? true

  const dismiss = () => {
    if (!projectId) return
    setDismissed(true)
    setSettingMutation.mutate({ key: `slay_nudge_dismissed:${projectId}`, value: '1' })
  }

  const recheck = useCallback(async () => {
    if (!projectPath) return
    const configured = await queryClient.fetchQuery(trpc.aiConfig.checkSlayConfigured.queryOptions({ projectPath }))
    if (configured) setDismissed(true)
  }, [projectPath, queryClient, trpc])

  return {
    showBanner: !dismissed && !slayConfigured,
    dismiss,
    recheck,
  }
}
