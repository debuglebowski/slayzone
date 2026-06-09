import { useCallback, useEffect, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import { toast, type AgentModel } from '@slayzone/ui'

interface SessionInfoLite {
  chatModel?: AgentModel | null
}

interface UseChatModelOpts {
  taskId: string
  mode: string
  tabId: string
  cwd: string
}

/**
 * Owns chat-model state. Mirrors useChatMode: server-authoritative, hydrate
 * from live session > DB cache, kill+respawn on change so the new flag set
 * takes effect. Initial value is `null` until hydrated — caller should hide
 * or skeletonize the pill while loading.
 */
export function useChatModel({ taskId, mode, tabId, cwd }: UseChatModelOpts) {
  const trpcClient = useTRPCClient()
  const [chatModel, setChatModelState] = useState<AgentModel | null>(null)
  const [modelChanging, setModelChanging] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const info = (await trpcClient.chat.getInfo.query({ tabId })) as SessionInfoLite | null
        if (cancelled) return
        if (info?.chatModel) {
          setChatModelState(info.chatModel)
          return
        }
        const cached = (await trpcClient.chat.getModel.query({ taskId, mode })) as AgentModel
        if (!cancelled) setChatModelState(cached)
      } catch {
        /* leave null */
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, mode, tabId])

  const handleModelChange = useCallback(
    async (next: AgentModel) => {
      if (next === chatModel || modelChanging) return
      setModelChanging(true)
      try {
        const info = (await trpcClient.chat.setModel.mutate({
          tabId,
          taskId,
          mode,
          cwd,
          chatModel: next
        })) as SessionInfoLite
        if (info?.chatModel) setChatModelState(info.chatModel)
        else setChatModelState(next)
      } catch (err) {
        toast(`Model change failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setModelChanging(false)
      }
    },
    [chatModel, modelChanging, tabId, taskId, mode, cwd, trpcClient]
  )

  return { chatModel, modelChanging, handleModelChange }
}
