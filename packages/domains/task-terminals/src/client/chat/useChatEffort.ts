import { useCallback, useEffect, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import { toast, useStableCallback, type AgentEffort } from '@slayzone/ui'
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

type TRPCClient = ReturnType<typeof useTRPCClient>

// Imperative IPC bodies live outside the hook: the React Compiler cannot lower
// value blocks inside try/catch or `finally` clauses, so keeping them here lets
// the hook itself compile.
async function hydrateChatEffort(
  trpcClient: TRPCClient,
  { taskId, mode, tabId }: { taskId: string; mode: string; tabId: string },
  isCancelled: () => boolean,
  setChatEffortState: (v: AgentEffort) => void
): Promise<void> {
  try {
    const info = (await trpcClient.chat.getInfo.query({ tabId })) as SessionInfoLite | null
    if (isCancelled()) return
    if (info && info.chatEffort) {
      setChatEffortState(info.chatEffort)
      return
    }
    const cached = (await trpcClient.chat.getEffort.query({
      taskId,
      mode
    })) as AgentEffort | null
    if (!isCancelled()) setChatEffortState(cached ?? DEFAULT_CHAT_EFFORT)
  } catch {
    /* keep DEFAULT_CHAT_EFFORT */
  }
}

async function applyChatEffort(
  trpcClient: TRPCClient,
  args: { tabId: string; taskId: string; mode: string; cwd: string; chatEffort: AgentEffort },
  setChatEffortState: (v: AgentEffort) => void,
  setEffortChanging: (v: boolean) => void
): Promise<void> {
  setEffortChanging(true)
  try {
    const info = (await trpcClient.chat.setEffort.mutate(args)) as SessionInfoLite
    if (info && info.chatEffort) setChatEffortState(info.chatEffort)
    else setChatEffortState(args.chatEffort)
  } catch (err) {
    toast(`Effort change failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    setEffortChanging(false)
  }
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

  // Reads the latest trpcClient; hydration re-runs only on task/mode/tab change.
  const hydrate = useStableCallback(
    (ids: { taskId: string; mode: string; tabId: string }, isCancelled: () => boolean) => {
      void hydrateChatEffort(trpcClient, ids, isCancelled, setChatEffortState)
    }
  )

  useEffect(() => {
    let cancelled = false
    hydrate({ taskId, mode, tabId }, () => cancelled)
    return () => {
      cancelled = true
    }
  }, [taskId, mode, tabId, hydrate])

  const handleEffortChange = useCallback(
    async (next: AgentEffort) => {
      if (next === chatEffort || effortChanging) return
      await applyChatEffort(
        trpcClient,
        { tabId, taskId, mode, cwd, chatEffort: next },
        setChatEffortState,
        setEffortChanging
      )
    },
    [chatEffort, effortChanging, tabId, taskId, mode, cwd, trpcClient]
  )

  return { chatEffort, effortChanging, handleEffortChange }
}
