import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useStableCallback } from '@slayzone/ui'
import { useTRPC } from '../trpc'
import { chatModelsView, type ChatModelsView } from '@slayzone/terminal-contracts'

/**
 * The models a chat tab offers (`chat.getModels`). Read again when a new
 * session starts (`sessionKey`): its handshake may have listed new models.
 */
export function useChatModels({
  taskId,
  mode,
  sessionKey
}: {
  taskId: string
  mode: string
  sessionKey: string | null
}): ChatModelsView {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data } = useQuery(trpc.chat.getModels.queryOptions({ taskId, mode }))
  const refresh = useStableCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: trpc.chat.getModels.queryKey({ taskId, mode })
    })
  })
  useEffect(() => {
    if (sessionKey) refresh()
  }, [sessionKey, refresh])
  return useMemo(() => chatModelsView(mode, data), [mode, data])
}
