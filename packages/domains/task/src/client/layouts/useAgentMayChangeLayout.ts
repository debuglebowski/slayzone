/**
 * The per-user `agent_may_change_layout` setting (docs/plans/panel-model.md step
 * 13): may agent sessions change task layouts (`slay panels layout …`)? Default
 * yes. While off, the hub refuses their changes with 403 `layout_locked`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AGENT_MAY_CHANGE_LAYOUT_SETTING_KEY, agentMayChangeLayout } from '@slayzone/task-contracts'
import { toast, useStableCallback } from '@slayzone/ui'
import { useTRPC } from '../trpc'

export function useAgentMayChangeLayout(): {
  allowed: boolean
  setAllowed: (allowed: boolean) => void
} {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const options = trpc.settings.get.queryOptions(
    { key: AGENT_MAY_CHANGE_LAYOUT_SETTING_KEY },
    { staleTime: 0 }
  )
  const { data } = useQuery(options)
  const { mutateAsync: setSetting } = useMutation(trpc.settings.set.mutationOptions())
  const setAllowed = useStableCallback((allowed: boolean) => {
    const value = allowed ? '1' : '0'
    queryClient.setQueryData(options.queryKey, value)
    setSetting({ key: AGENT_MAY_CHANGE_LAYOUT_SETTING_KEY, value }).catch(() => {
      toast.error("Couldn't save the setting")
      void queryClient.invalidateQueries({ queryKey: options.queryKey })
    })
  })
  return { allowed: agentMayChangeLayout(data), setAllowed }
}
