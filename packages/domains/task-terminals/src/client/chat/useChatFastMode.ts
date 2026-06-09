import { useCallback, useEffect, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import { toast } from '@slayzone/ui'
import { DEFAULT_CHAT_FAST_MODE } from '@slayzone/terminal/shared'

interface SessionInfoLite {
  chatFastMode?: boolean
}

interface UseChatFastModeOpts {
  taskId: string
  mode: string
  tabId: string
  cwd: string
}

/**
 * Owns chat Fast Mode state (Codex `serviceTier: 'fast'`). Mirrors
 * useChatEffort: server-authoritative, hydrate from live session > DB cache,
 * kill+respawn on change.
 *
 * Only meaningful for `codex-chat`; the control is hidden for other modes.
 */
export function useChatFastMode({ taskId, mode, tabId, cwd }: UseChatFastModeOpts) {
  const trpcClient = useTRPCClient()
  const [chatFastMode, setChatFastModeState] = useState<boolean>(DEFAULT_CHAT_FAST_MODE)
  const [fastModeChanging, setFastModeChanging] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const info = (await trpcClient.chat.getInfo.query({ tabId })) as SessionInfoLite | null
        if (cancelled) return
        if (info && typeof info.chatFastMode === 'boolean') {
          setChatFastModeState(info.chatFastMode)
          return
        }
        const cached = await trpcClient.chat.getFastMode.query({ taskId, mode })
        if (!cancelled) setChatFastModeState(cached ?? DEFAULT_CHAT_FAST_MODE)
      } catch {
        /* keep DEFAULT_CHAT_FAST_MODE */
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, mode, tabId])

  const handleFastModeChange = useCallback(
    async (next: boolean) => {
      if (next === chatFastMode || fastModeChanging) return
      setFastModeChanging(true)
      try {
        const info = (await trpcClient.chat.setFastMode.mutate({
          tabId,
          taskId,
          mode,
          cwd,
          chatFastMode: next
        })) as SessionInfoLite
        if (info && typeof info.chatFastMode === 'boolean') setChatFastModeState(info.chatFastMode)
        else setChatFastModeState(next)
      } catch (err) {
        toast(`Fast mode change failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setFastModeChanging(false)
      }
    },
    [chatFastMode, fastModeChanging, tabId, taskId, mode, cwd, trpcClient]
  )

  return { chatFastMode, fastModeChanging, handleFastModeChange }
}
