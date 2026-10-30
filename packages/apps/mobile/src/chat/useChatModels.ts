/**
 * The models a chat offers (`chat.getModels`) — desktop's `useChatModels`
 * (`task-terminals/src/client/chat/useChatModels.ts`): Claude's fixed list, or what
 * Codex's CLI listed for the account; never a Codex list of this app's. Read again
 * when a new session starts (`sessionKey`): its handshake may have listed new models.
 */
import { type ChatModelsView, chatModelsView } from '@slayzone/terminal-contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useTRPC } from '../trpc'
import { useStableCallback } from './useStableCallback'

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
  return chatModelsView(mode, data)
}
