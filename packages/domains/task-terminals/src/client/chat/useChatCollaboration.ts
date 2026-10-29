import { useCallback, useEffect, useState } from 'react'
import { useTRPCClient } from '../trpc'
import { toast, useStableCallback } from '@slayzone/ui'
import {
  DEFAULT_CHAT_COLLABORATION,
  type ChatCollaborationMode
} from '@slayzone/terminal-contracts'

interface SessionInfoLite {
  chatCollaboration?: ChatCollaborationMode | null
}

interface UseChatCollaborationOpts {
  taskId: string
  mode: string
  tabId: string
  cwd: string
}

type TRPCClient = ReturnType<typeof useTRPCClient>

// Imperative IPC bodies live outside the hook: the React Compiler cannot lower
// value blocks inside try/catch or `finally` clauses, so keeping them here lets
// the hook itself compile.
async function hydrateChatCollaboration(
  trpcClient: TRPCClient,
  { taskId, mode, tabId }: { taskId: string; mode: string; tabId: string },
  isCancelled: () => boolean,
  setChatCollaborationState: (v: ChatCollaborationMode) => void
): Promise<void> {
  try {
    const info = (await trpcClient.chat.getInfo.query({ tabId })) as SessionInfoLite | null
    if (isCancelled()) return
    if (info && info.chatCollaboration) {
      setChatCollaborationState(info.chatCollaboration)
      return
    }
    const cached = (await trpcClient.chat.getCollaboration.query({
      taskId,
      mode
    })) as ChatCollaborationMode | null
    if (!isCancelled()) setChatCollaborationState(cached ?? DEFAULT_CHAT_COLLABORATION)
  } catch {
    /* keep DEFAULT_CHAT_COLLABORATION */
  }
}

async function applyChatCollaboration(
  trpcClient: TRPCClient,
  args: {
    tabId: string
    taskId: string
    mode: string
    cwd: string
    chatCollaboration: ChatCollaborationMode
  },
  setChatCollaborationState: (v: ChatCollaborationMode) => void,
  setCollaborationChanging: (v: boolean) => void
): Promise<void> {
  setCollaborationChanging(true)
  try {
    const info = (await trpcClient.chat.setCollaboration.mutate(args)) as SessionInfoLite
    if (info && info.chatCollaboration) setChatCollaborationState(info.chatCollaboration)
    else setChatCollaborationState(args.chatCollaboration)
  } catch (err) {
    toast(`Collaboration mode change failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    setCollaborationChanging(false)
  }
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
  const [chatCollaboration, setChatCollaborationState] = useState<ChatCollaborationMode>(
    DEFAULT_CHAT_COLLABORATION
  )
  const [collaborationChanging, setCollaborationChanging] = useState(false)

  // Reads the latest trpcClient; hydration re-runs only on task/mode/tab change.
  const hydrate = useStableCallback(
    (ids: { taskId: string; mode: string; tabId: string }, isCancelled: () => boolean) => {
      void hydrateChatCollaboration(trpcClient, ids, isCancelled, setChatCollaborationState)
    }
  )

  useEffect(() => {
    let cancelled = false
    hydrate({ taskId, mode, tabId }, () => cancelled)
    return () => {
      cancelled = true
    }
  }, [taskId, mode, tabId, hydrate])

  const handleCollaborationChange = useCallback(
    async (next: ChatCollaborationMode) => {
      if (next === chatCollaboration || collaborationChanging) return
      await applyChatCollaboration(
        trpcClient,
        { tabId, taskId, mode, cwd, chatCollaboration: next },
        setChatCollaborationState,
        setCollaborationChanging
      )
    },
    [chatCollaboration, collaborationChanging, tabId, taskId, mode, cwd, trpcClient]
  )

  return { chatCollaboration, collaborationChanging, handleCollaborationChange }
}
