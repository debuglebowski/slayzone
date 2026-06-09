import { useCallback, useEffect, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import { toast } from '@slayzone/ui'
import { DEFAULT_CHAT_COLLABORATION, type ChatCollaborationMode } from '@slayzone/terminal/shared'

interface SessionInfoLite {
  chatCollaboration?: ChatCollaborationMode | null
}

interface UseChatCollaborationOpts {
  taskId: string
  mode: string
  tabId: string
  cwd: string
}

/**
 * Owns chat collaboration-mode state (Codex `plan`/`default`). Mirrors
 * useChatEffort: server-authoritative, hydrate from live session > DB cache,
 * kill+respawn on change so the new `turn/start.collaborationMode` takes effect
 * on a cleanly re-initialized thread.
 *
 * Only meaningful for `codex-chat`; the dropdown is hidden for other modes.
 */
export function useChatCollaboration({ taskId, mode, tabId, cwd }: UseChatCollaborationOpts) {
  const trpcClient = useTRPCClient()
  const [chatCollaboration, setChatCollaborationState] =
    useState<ChatCollaborationMode>(DEFAULT_CHAT_COLLABORATION)
  const [collaborationChanging, setCollaborationChanging] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const info = (await trpcClient.chat.getInfo.query({ tabId })) as SessionInfoLite | null
        if (cancelled) return
        if (info && info.chatCollaboration) {
          setChatCollaborationState(info.chatCollaboration)
          return
        }
        const cached = (await trpcClient.chat.getCollaboration.query({
          taskId,
          mode
        })) as ChatCollaborationMode | null
        if (!cancelled) setChatCollaborationState(cached ?? DEFAULT_CHAT_COLLABORATION)
      } catch {
        /* keep DEFAULT_CHAT_COLLABORATION */
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, mode, tabId])

  const handleCollaborationChange = useCallback(
    async (next: ChatCollaborationMode) => {
      if (next === chatCollaboration || collaborationChanging) return
      setCollaborationChanging(true)
      try {
        const info = (await trpcClient.chat.setCollaboration.mutate({
          tabId,
          taskId,
          mode,
          cwd,
          chatCollaboration: next
        })) as SessionInfoLite
        if (info && info.chatCollaboration) setChatCollaborationState(info.chatCollaboration)
        else setChatCollaborationState(next)
      } catch (err) {
        toast(
          `Collaboration mode change failed: ${err instanceof Error ? err.message : String(err)}`
        )
      } finally {
        setCollaborationChanging(false)
      }
    },
    [chatCollaboration, collaborationChanging, tabId, taskId, mode, cwd, trpcClient]
  )

  return { chatCollaboration, collaborationChanging, handleCollaborationChange }
}
