import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useStableCallback } from '@slayzone/ui'
import {
  defaultChatEffortSettingKey,
  defaultChatModelSettingKey,
  defaultChatModeSettingKey,
  resolveDefaultChatMode
} from '@slayzone/terminal-contracts'
import { useTRPC } from '../trpc'

/** One `settings` value: its stored string (undefined until loaded / unset) and a setter. */
function useSetting(key: string) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data } = useQuery(trpc.settings.get.queryOptions({ key }))
  const { mutate } = useMutation(
    trpc.settings.set.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey({ key }) })
    })
  )
  const set = useStableCallback((value: string) => mutate({ key, value }))
  return { data, set }
}

/**
 * The user's defaults for a chat provider: permission mode (also editable in
 * Settings → Providers), model and reasoning effort (the pickers' "Set
 * default"). Chat tasks that never picked one spawn with it. Each is undefined
 * until loaded; model/effort also when unset.
 */
export function useChatDefaults(mode: string) {
  const modeSetting = useSetting(defaultChatModeSettingKey(mode))
  const modelSetting = useSetting(defaultChatModelSettingKey(mode))
  const effortSetting = useSetting(defaultChatEffortSettingKey(mode))
  return {
    defaultMode:
      modeSetting.data === undefined ? undefined : resolveDefaultChatMode(mode, modeSetting.data),
    setDefaultMode: modeSetting.set,
    defaultModel: modelSetting.data || undefined,
    setDefaultModel: modelSetting.set,
    defaultEffort: effortSetting.data || undefined,
    setDefaultEffort: effortSetting.set
  }
}
