import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ChatAvailability } from '@slayzone/terminal-contracts'
import { useTRPC } from './trpc'

type Stamp = { tabId: string; state: ChatAvailability['state'] | 'unreachable' }
async function retryAvailability(opts: {
  tabId: string
  refetch: () => Promise<{ data?: ChatAvailability; error: unknown }>
  previous: RefObject<Stamp | null>
  retrying: RefObject<boolean>
  onReady: () => void
}) {
  if (opts.retrying.current) return
  opts.retrying.current = true
  try {
    const result = await opts.refetch()
    opts.previous.current = {
      tabId: opts.tabId,
      state: result.error ? 'unreachable' : (result.data?.state ?? 'unreachable')
    }
  } catch {
    opts.previous.current = { tabId: opts.tabId, state: 'unreachable' }
  } finally {
    opts.retrying.current = false
  }
  opts.onReady()
}

/** Hub-scoped metadata polling. Reconnect replays history; it never retries a send. */
export function useChatAvailability(opts: { tabId: string; active: boolean; onReady: () => void }) {
  const trpc = useTRPC()
  const previous = useRef<Stamp | null>(null),
    retrying = useRef(false)
  const { data, error, refetch } = useQuery({
    ...trpc.chat.availability.queryOptions({ tabId: opts.tabId }),
    enabled: opts.active,
    retry: false,
    refetchInterval: (query) => (query.state.data?.state === 'ready' ? 15_000 : 2_000)
  })
  const { tabId, active, onReady } = opts
  useEffect(() => {
    if (!active) return
    const state = error ? 'unreachable' : data?.state
    if (!state) return
    const before = previous.current
    previous.current = { tabId, state }
    if (
      before?.tabId === tabId &&
      before.state !== 'ready' &&
      state === 'ready' &&
      !retrying.current
    )
      onReady()
  }, [active, tabId, data, error, onReady])
  const retry = useCallback(
    () => retryAvailability({ tabId, refetch, previous, retrying, onReady }),
    [tabId, refetch, onReady]
  )
  return { status: data ?? null, error: error ? error.message : null, retry }
}
