import { useEffect, useRef, useState } from 'react'
import { useStableCallback } from '@slayzone/ui'
import type { SideQuestionExchange } from '@slayzone/terminal-contracts'
import { useTRPCClient } from '../../trpc'

/** One `/btw` question of the open side discussion and how it stands. */
export interface SideExchange {
  id: string
  question: string
  status: 'asking' | 'answered' | 'failed'
  /** The answer; null while asking, or when the agent gave none. */
  answer: string | null
  error: string | null
}

export interface SideQuestionTarget {
  tabId: string
  taskId: string
  mode: string
  cwd: string
  providerFlagsOverride?: string | null
}

const NONE: SideExchange[] = []

/**
 * The tab's side discussion (`/btw`): questions answered from the conversation
 * — while a turn runs too — that never enter it. Lives only here: closing it,
 * closing the tab, or a reload drops it (like the CLIs' own `/btw`). A
 * follow-up carries the earlier answered exchanges.
 */
export function useSideQuestions(target: SideQuestionTarget) {
  const client = useTRPCClient()
  const [exchanges, setExchanges] = useState<SideExchange[]>(NONE)
  /** Ids still being answered — cancelled when the discussion or the tab closes. */
  const pending = useRef(new Set<string>())

  const settle = (id: string, patch: Partial<SideExchange>): void => {
    pending.current.delete(id)
    setExchanges((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)))
  }

  const ask = useStableCallback((question: string) => {
    const id = crypto.randomUUID()
    const history: SideQuestionExchange[] = exchanges
      .filter((e) => e.status === 'answered' && e.answer)
      .map((e) => ({ question: e.question, answer: e.answer ?? '' }))
    pending.current.add(id)
    setExchanges((prev) => [...prev, { id, question, status: 'asking', answer: null, error: null }])
    client.chat.sideQuestion.ask.mutate({ ...target, requestId: id, question, history }).then(
      (res) => settle(id, { status: 'answered', answer: res.text }),
      (err: unknown) =>
        settle(id, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err)
        })
    )
  })

  const cancelPending = useStableCallback(() => {
    for (const requestId of pending.current) {
      client.chat.sideQuestion.cancel
        .mutate({ tabId: target.tabId, requestId })
        .catch(() => undefined)
    }
    pending.current.clear()
  })

  /** Close the discussion; questions still running are cancelled. */
  const dismiss = useStableCallback(() => {
    cancelPending()
    setExchanges(NONE)
  })

  // The tab closed (or the panel left): nothing keeps answering for it.
  useEffect(() => cancelPending, [cancelPending])

  return { exchanges, open: exchanges.length > 0, ask, dismiss }
}
