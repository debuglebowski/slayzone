import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSubscription } from '@slayzone/transport/client'
import { toast, useStableCallback } from '@slayzone/ui'
import { useTRPC, useTRPCClient } from '../trpc'
import type { ChatThread } from '@slayzone/terminal-contracts'

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
  const query = useQuery(
    trpc.chat.threads.list.queryOptions(
      { ...target, conversationId },
      { enabled: enabled && !!conversationId }
    )
  )
  const [selection, setSelection] = useState<{
    conversationId: string
    answerId: string
    sourceMessageId: string
    activeId: string | null
  } | null>(null)
  const [creating, setCreating] = useState(false)
  const threads = query.data ?? NO_THREADS
  // A reset/session switch keeps the old discussions durable, but this panel
  // only shows threads belonging to the conversation currently on screen.
  const panel = selection?.conversationId === conversationId ? selection : null
  useSubscription(
    trpc.chat.threads.onChanged.subscriptionOptions(
      { tabId: target.tabId },
      {
        enabled: enabled && !!conversationId,
        onData: () => {
          void query.refetch()
        }
      }
    )
  )
  const start = useStableCallback((answerId: string, sourceMessageId: string) => {
    if (conversationId) setSelection({ conversationId, answerId, sourceMessageId, activeId: null })
  })
  const open = useStableCallback((thread: ChatThread) => {
    setSelection({
      conversationId: thread.parentConversationId,
      answerId: thread.answerId,
      sourceMessageId: thread.sourceMessageId,
      activeId: thread.id
    })
  })
  const select = useStableCallback((activeId: string | null) => {
    setSelection((prev) => (prev ? { ...prev, activeId } : null))
  })
  const close = useStableCallback(() => setSelection(null))
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
          await query.refetch()
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
