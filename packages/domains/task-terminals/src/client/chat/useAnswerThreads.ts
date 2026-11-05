import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useHubId, useSubscription } from '@slayzone/transport/client'
import { toast, useStableCallback } from '@slayzone/ui'
import { useTRPC, useTRPCClient } from '../trpc'
import type { ChatThread } from '@slayzone/terminal-contracts'
import {
  answerThreadsPanelKey,
  readAnswerThreadsPanel,
  writeAnswerThreadsPanel,
  type AnswerThreadsPanel
} from './answer-threads-panel'

const NO_THREADS: ChatThread[] = []

export function useAnswerThreads(
  target: {
    tabId: string
    taskId: string
    mode: string
    cwd: string
    providerFlagsOverride?: string | null
  },
  enabled: boolean,
  conversationId: string | null
) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const {
    data,
    isSuccess,
    refetch: refetchThreads
  } = useQuery(
    trpc.chat.threads.list.queryOptions(
      { ...target, conversationId },
      { enabled: enabled && !!conversationId }
    )
  )
  // The open panel survives reloads and restarts (`answer-threads-panel.ts`).
  const storageKey = answerThreadsPanelKey(useHubId() ?? 'local', target.tabId)
  const [stored, setStored] = useState<{
    key: string
    selection: AnswerThreadsPanel | null
  }>(() => ({ key: storageKey, selection: enabled ? readAnswerThreadsPanel(storageKey) : null }))
  if (stored.key !== storageKey)
    setStored({ key: storageKey, selection: enabled ? readAnswerThreadsPanel(storageKey) : null })
  const selection = stored.key === storageKey ? stored.selection : null
  const setSelection = (
    next: (prev: AnswerThreadsPanel | null) => AnswerThreadsPanel | null
  ): void => {
    setStored((prev) =>
      prev.key === storageKey ? { key: storageKey, selection: next(prev.selection) } : prev
    )
  }
  useEffect(() => {
    if (enabled && stored.key === storageKey) writeAnswerThreadsPanel(storageKey, stored.selection)
  }, [enabled, stored, storageKey])
  const [creating, setCreating] = useState(false)
  const threads = data ?? NO_THREADS
  // A reset/session switch keeps the old discussions durable, but this panel
  // only shows threads belonging to the conversation currently on screen.
  const panel = selection?.conversationId === conversationId ? selection : null
  // A remembered thread that no longer exists (its tab went away): close.
  if (panel?.activeId && isSuccess && !threads.some((thread) => thread.id === panel.activeId))
    setStored({ key: storageKey, selection: null })
  useSubscription(
    trpc.chat.threads.onChanged.subscriptionOptions(
      { tabId: target.tabId },
      {
        enabled: enabled && !!conversationId,
        onData: () => {
          void refetchThreads()
        }
      }
    )
  )
  const start = useStableCallback((answerId: string, sourceMessageId: string) => {
    if (conversationId)
      setSelection(() => ({ conversationId, answerId, sourceMessageId, activeId: null }))
  })
  const open = useStableCallback((thread: ChatThread) => {
    setSelection(() => ({
      conversationId: thread.parentConversationId,
      answerId: thread.answerId,
      sourceMessageId: thread.sourceMessageId,
      activeId: thread.id
    }))
  })
  const select = useStableCallback((activeId: string | null) => {
    setSelection((prev) => (prev ? { ...prev, activeId } : null))
  })
  const close = useStableCallback(() => setSelection(() => null))
  const create = useStableCallback(async (text: string): Promise<boolean> => {
    if (!panel || creating || !text.trim()) return false
    setCreating(true)
    let success = false
    await client.chat.threads.create
      .mutate({
        ...target,
        messageId: panel.sourceMessageId,
        answerId: panel.answerId,
        title: text.trim().replace(/\s+/g, ' ').slice(0, 80),
        text
      })
      .then(
        async (thread) => {
          await refetchThreads()
          setSelection((prev) =>
            prev?.conversationId === panel.conversationId &&
            prev.sourceMessageId === panel.sourceMessageId &&
            prev.answerId === panel.answerId
              ? { ...prev, activeId: thread.id }
              : prev
          )
          success = true
        },
        (err: unknown) => {
          toast(`Couldn't start thread: ${err instanceof Error ? err.message : String(err)}`)
        }
      )
      .then(() => setCreating(false))
    return success
  })
  const view = useMemo(
    () => (enabled ? { threads, start, open } : undefined),
    [enabled, threads, start, open]
  )
  return { threads, panel, creating, create, select, close, view }
}
