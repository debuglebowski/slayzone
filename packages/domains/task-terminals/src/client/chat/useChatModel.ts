import { useCallback, useEffect, useState } from 'react'
import { useTRPCClient } from '../trpc'
import { toast, useStableCallback, type AgentModel } from '@slayzone/ui'

interface SessionInfoLite {
  chatModel?: AgentModel | null
}

interface UseChatModelOpts {
  taskId: string
  mode: string
  tabId: string
  cwd: string
}

type TRPCClient = ReturnType<typeof useTRPCClient>

// Imperative IPC bodies live outside the hook: the React Compiler cannot lower
// value blocks inside try/catch or `finally` clauses, so keeping them here lets
// the hook itself compile.
async function hydrateChatModel(
  trpcClient: TRPCClient,
  { taskId, mode, tabId }: { taskId: string; mode: string; tabId: string },
  isCancelled: () => boolean,
  setChatModelState: (v: AgentModel) => void
): Promise<void> {
  try {
    const info = (await trpcClient.chat.getInfo.query({ tabId })) as SessionInfoLite | null
    if (isCancelled()) return
    if (info?.chatModel) {
      setChatModelState(info.chatModel)
      return
    }
    const cached = (await trpcClient.chat.getModel.query({ taskId, mode })) as AgentModel
    if (!isCancelled()) setChatModelState(cached)
  } catch {
    /* leave null */
  }
}

async function applyChatModel(
  trpcClient: TRPCClient,
  args: { tabId: string; taskId: string; mode: string; cwd: string; chatModel: AgentModel },
  setChatModelState: (v: AgentModel) => void,
  setModelChanging: (v: boolean) => void
): Promise<void> {
  setModelChanging(true)
  try {
    const info = (await trpcClient.chat.setModel.mutate(args)) as SessionInfoLite
    if (info?.chatModel) setChatModelState(info.chatModel)
    else setChatModelState(args.chatModel)
  } catch (err) {
    toast(`Model change failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    setModelChanging(false)
  }
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

  // Reads the latest trpcClient; hydration re-runs only on task/mode/tab change.
  const hydrate = useStableCallback(
    (ids: { taskId: string; mode: string; tabId: string }, isCancelled: () => boolean) => {
      void hydrateChatModel(trpcClient, ids, isCancelled, setChatModelState)
    }
  )

  useEffect(() => {
    let cancelled = false
    hydrate({ taskId, mode, tabId }, () => cancelled)
    return () => {
      cancelled = true
    }
  }, [taskId, mode, tabId, hydrate])

  const handleModelChange = useCallback(
    async (next: AgentModel) => {
      if (next === chatModel || modelChanging) return
      await applyChatModel(
        trpcClient,
        { tabId, taskId, mode, cwd, chatModel: next },
        setChatModelState,
        setModelChanging
      )
    },
    [chatModel, modelChanging, tabId, taskId, mode, cwd, trpcClient]
  )

  return { chatModel, modelChanging, handleModelChange }
}
