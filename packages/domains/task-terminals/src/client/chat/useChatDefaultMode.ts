import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useStableCallback } from '@slayzone/ui'
import { defaultChatModeSettingKey, resolveDefaultChatMode } from '@slayzone/terminal-contracts'
import { useTRPC } from '../trpc'

/**
 * The user's default permission mode for a chat provider (`settings`, also
 * editable in Settings → Providers). Chat tasks that never picked a mode spawn
 * in it. `defaultMode` is undefined until loaded.
 */
export function useChatDefaultMode(mode: string) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const key = defaultChatModeSettingKey(mode)
  const { data } = useQuery(trpc.settings.get.queryOptions({ key }))
  const { mutate } = useMutation(
    trpc.settings.set.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey({ key }) })
    })
  )
  const defaultMode = data === undefined ? undefined : resolveDefaultChatMode(mode, data)
  const setDefaultMode = useStableCallback((next: string) => mutate({ key, value: next }))
  return { defaultMode, setDefaultMode }
}
