import { useCallback, useEffect, useState } from 'react'
import { useTRPCClient } from '../trpc'
import { toast, useStableCallback } from '@slayzone/ui'
import { DEFAULT_CHAT_FAST_MODE } from '@slayzone/terminal-contracts'

interface SessionInfoLite {
  chatFastMode?: boolean
}

interface UseChatFastModeOpts {
  taskId: string
  mode: string
  tabId: string
  cwd: string
}

type TRPCClient = ReturnType<typeof useTRPCClient>

// Imperative IPC bodies live outside the hook: the React Compiler cannot lower
// value blocks inside try/catch or `finally` clauses, so keeping them here lets
// the hook itself compile.
async function hydrateChatFastMode(
  trpcClient: TRPCClient,
  { taskId, mode, tabId }: { taskId: string; mode: string; tabId: string },
  isCancelled: () => boolean,
  setChatFastModeState: (v: boolean) => void
): Promise<void> {
  try {
    const info = (await trpcClient.chat.getInfo.query({ tabId })) as SessionInfoLite | null
    if (isCancelled()) return
    if (info && typeof info.chatFastMode === 'boolean') {
      setChatFastModeState(info.chatFastMode)
      return
    }
    const cached = await trpcClient.chat.getFastMode.query({ taskId, mode })
    if (!isCancelled()) setChatFastModeState(cached ?? DEFAULT_CHAT_FAST_MODE)
  } catch {
    /* keep DEFAULT_CHAT_FAST_MODE */
  }
}

async function applyChatFastMode(
  trpcClient: TRPCClient,
  args: { tabId: string; taskId: string; mode: string; cwd: string; chatFastMode: boolean },
  setChatFastModeState: (v: boolean) => void,
  setFastModeChanging: (v: boolean) => void
): Promise<void> {
  setFastModeChanging(true)
  try {
    const info = (await trpcClient.chat.setFastMode.mutate(args)) as SessionInfoLite
    if (info && typeof info.chatFastMode === 'boolean') setChatFastModeState(info.chatFastMode)
    else setChatFastModeState(args.chatFastMode)
  } catch (err) {
    toast(`Fast mode change failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    setFastModeChanging(false)
  }
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

  // Reads the latest trpcClient; hydration re-runs only on task/mode/tab change.
  const hydrate = useStableCallback(
    (ids: { taskId: string; mode: string; tabId: string }, isCancelled: () => boolean) => {
      void hydrateChatFastMode(trpcClient, ids, isCancelled, setChatFastModeState)
    }
  )

  useEffect(() => {
    let cancelled = false
    hydrate({ taskId, mode, tabId }, () => cancelled)
    return () => {
      cancelled = true
    }
  }, [taskId, mode, tabId, hydrate])

  const handleFastModeChange = useCallback(
    async (next: boolean) => {
      if (next === chatFastMode || fastModeChanging) return
      await applyChatFastMode(
        trpcClient,
        { tabId, taskId, mode, cwd, chatFastMode: next },
        setChatFastModeState,
        setFastModeChanging
      )
    },
    [chatFastMode, fastModeChanging, tabId, taskId, mode, cwd, trpcClient]
  )

  return { chatFastMode, fastModeChanging, handleFastModeChange }
}
