import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ChatAvailability } from '@slayzone/terminal-contracts'
import { useTRPC } from './trpc'

type Stamp = { tabId: string; state: ChatAvailability['state'] | 'unreachable' }
type Refresh = { tabId: string; onReady?: () => void }
async function refreshAvailability(opts: {
  tabId: string
  refetch: () => Promise<{ data?: ChatAvailability; error: unknown }>
  previous: RefObject<Stamp | null>
  refreshing: RefObject<Refresh | null>
  onReady?: () => void
}) {
  const existing = opts.refreshing.current
  if (existing?.tabId === opts.tabId) {
    existing.onReady ??= opts.onReady
    return
  }
  const refresh: Refresh = { tabId: opts.tabId, onReady: opts.onReady }
  opts.refreshing.current = refresh
  try {
    const result = await opts.refetch()
    if (opts.refreshing.current !== refresh) return
    opts.previous.current = {
      tabId: opts.tabId,
      state: result.error ? 'unreachable' : (result.data?.state ?? 'unreachable')
    }
  } catch {
    if (opts.refreshing.current !== refresh) return
    opts.previous.current = { tabId: opts.tabId, state: 'unreachable' }
  } finally {
    if (opts.refreshing.current === refresh) {
      opts.refreshing.current = null
      refresh.onReady?.()
    }
  }
}

/** Hub-scoped metadata polling. Reconnect replays history; it never retries a send. */
export function useChatAvailability(opts: {
  tabId: string
  active: boolean
  /** Current history loaded successfully. Refresh status; never assume it is ready. */
  historyReady?: boolean
  onReady: () => void
}) {
  const trpc = useTRPC()
  const previous = useRef<Stamp | null>(null),
    refreshing = useRef<Refresh | null>(null),
    completedHistory = useRef<string | null>(null)
  const { data, error, isFetching, refetch } = useQuery({
    ...trpc.chat.availability.queryOptions({ tabId: opts.tabId }),
    enabled: opts.active,
    retry: false,
    refetchInterval: (query) => (query.state.data?.state === 'ready' ? 15_000 : 2_000)
  })
  const { tabId, active, historyReady = false, onReady } = opts
  useEffect(
    () => () => {
      refreshing.current = null
    },
    [tabId]
  )
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
      refreshing.current?.tabId !== tabId
    )
      onReady()
  }, [active, tabId, data, error, onReady])
  useEffect(() => {
    if (!historyReady) {
      completedHistory.current = null
      return
    }
    if (!active || isFetching || completedHistory.current === tabId) return
    completedHistory.current = tabId
    if (!error && data?.state === 'ready') return
    // Hydration can finish between availability polls. Confirm it immediately
    // instead of leaving a stale spinner for up to two seconds. This load is
    // already complete, so its ready transition must not start another load.
    void refreshAvailability({ tabId, refetch, previous, refreshing })
  }, [active, tabId, historyReady, data?.state, error, isFetching, refetch])
  const retry = useCallback(
    () => refreshAvailability({ tabId, refetch, previous, refreshing, onReady }),
    [tabId, refetch, onReady]
  )
  return { status: data ?? null, error: error ? error.message : null, retry }
}
