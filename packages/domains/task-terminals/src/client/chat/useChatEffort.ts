import { useCallback, useEffect, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import { toast, type AgentEffort } from '@slayzone/ui'
import { DEFAULT_CHAT_EFFORT } from '@slayzone/terminal/shared'

interface SessionInfoLite {
  chatEffort?: AgentEffort | null
}

interface UseChatEffortOpts {
  taskId: string
  mode: string
  tabId: string
  cwd: string
}

/**
 * Owns chat-effort state. Mirrors useChatModel: server-authoritative, hydrate
 * from live session > DB cache, kill+respawn on change so the new --effort
 * flag takes effect.
 *
 * Pill always renders a concrete level. Tasks with no persisted effort fall
 * back to `DEFAULT_CHAT_EFFORT` for display; nothing is written until the
 * user picks a level.
 */
export function useChatEffort({ taskId, mode, tabId, cwd }: UseChatEffortOpts) {
  const trpcClient = useTRPCClient()
  const [chatEffort, setChatEffortState] = useState<AgentEffort>(DEFAULT_CHAT_EFFORT)
  const [effortChanging, setEffortChanging] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const info = (await trpcClient.chat.getInfo.query({ tabId })) as SessionInfoLite | null
        if (cancelled) return
        if (info && info.chatEffort) {
          setChatEffortState(info.chatEffort)
          return
        }
        const cached = (await trpcClient.chat.getEffort.query({
          taskId,
          mode
        })) as AgentEffort | null
        if (!cancelled) setChatEffortState(cached ?? DEFAULT_CHAT_EFFORT)
      } catch {
        /* keep DEFAULT_CHAT_EFFORT */
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, mode, tabId])

  const handleEffortChange = useCallback(
    async (next: AgentEffort) => {
      if (next === chatEffort || effortChanging) return
      setEffortChanging(true)
      try {
        const info = (await trpcClient.chat.setEffort.mutate({
          tabId,
          taskId,
          mode,
          cwd,
          chatEffort: next
        })) as SessionInfoLite
        if (info && info.chatEffort) setChatEffortState(info.chatEffort)
        else setChatEffortState(next)
      } catch (err) {
        toast(`Effort change failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setEffortChanging(false)
      }
    },
    [chatEffort, effortChanging, tabId, taskId, mode, cwd, trpcClient]
  )

  return { chatEffort, effortChanging, handleEffortChange }
}
