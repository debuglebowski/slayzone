import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useStableCallback, useSubscription } from '@slayzone/transport/client'
import type { ChatAvailability } from '@slayzone/terminal-contracts'
import { useTRPC } from './trpc'

type Stamp = {
  tabId: string
  state: ChatAvailability['state'] | 'unreachable'
  generation?: string
}
type ReplaySignal = { tabId: string; generation: string }
const sameReplay = (a: ReplaySignal | null, b: ReplaySignal | null): boolean =>
  !!a && !!b && a.tabId === b.tabId && a.generation === b.generation
type Refresh = { tabId: string; onReady?: () => void }
async function refreshAvailability(opts: {
  tabId: string
  refetch: () => Promise<{ data?: ChatAvailability; error: unknown }>
  previous: RefObject<Stamp | null>
  refreshing: RefObject<Refresh | null>
  onReady?: () => void
  onRecovery?: () => void
  hasPendingReplay?: () => boolean
}) {
  const existing = opts.refreshing.current
  if (existing?.tabId === opts.tabId) {
    existing.onReady ??= opts.onReady
    return
  }
  const refresh: Refresh = { tabId: opts.tabId, onReady: opts.onReady }
  const before = opts.previous.current
  opts.refreshing.current = refresh
  try {
    const result = await opts.refetch()
    if (opts.refreshing.current !== refresh) return
    opts.previous.current = {
      tabId: opts.tabId,
      state: result.error ? 'unreachable' : (result.data?.state ?? 'unreachable'),
      generation:
        result.data?.recoveryGeneration ??
        (before?.tabId === opts.tabId ? before.generation : undefined)
    }
    if (
      !result.error &&
      result.data?.state === 'ready' &&
      ((before?.tabId === opts.tabId &&
        before.generation !== undefined &&
        result.data.recoveryGeneration !== undefined &&
        before.generation !== result.data.recoveryGeneration) ||
        opts.hasPendingReplay?.())
    )
      refresh.onReady ??= opts.onRecovery
  } catch {
    if (opts.refreshing.current !== refresh) return
    opts.previous.current = {
      tabId: opts.tabId,
      state: 'unreachable',
      generation: before?.tabId === opts.tabId ? before.generation : undefined
    }
  } finally {
    if (opts.refreshing.current === refresh) {
      opts.refreshing.current = null
      refresh.onReady?.()
    }
  }
}

/** Hub-scoped metadata. Recovery watermarks also catch disconnects between polls. */
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
    completedHistory = useRef<string | null>(null),
    requestedReplay = useRef<ReplaySignal | null>(null),
    lastReplay = useRef<ReplaySignal | null>(null),
    handledReplay = useRef<ReplaySignal | null>(null)
  const [replaySignal, setReplaySignal] = useState<ReplaySignal | null>(null)
  const { data, error, isFetching, refetch } = useQuery({
    ...trpc.chat.availability.queryOptions({ tabId: opts.tabId }),
    enabled: opts.active,
    retry: false,
    refetchInterval: (query) => (query.state.data?.state === 'ready' ? 15_000 : 2_000)
  })
  const { tabId, active, historyReady = false, onReady } = opts
  const hasPendingReplay = useCallback(
    () =>
      lastReplay.current?.tabId === tabId && !sameReplay(lastReplay.current, handledReplay.current),
    [tabId]
  )
  const reloadHistory = useCallback(() => {
    handledReplay.current = lastReplay.current
    onReady()
  }, [onReady])
  const handleReplay = useStableCallback((message: ReplaySignal) => {
    if (message.tabId !== tabId) return
    lastReplay.current = message
    setReplaySignal((before) => (sameReplay(before, message) ? before : message))
  })
  useSubscription(
    trpc.chat.onReplayRequired.subscriptionOptions(
      { tabId },
      {
        enabled: active && !!tabId,
        onData: handleReplay
      }
    )
  )
  useEffect(() => {
    if (
      !active ||
      isFetching ||
      replaySignal?.tabId !== tabId ||
      replaySignal.generation === data?.recoveryGeneration ||
      requestedReplay.current === replaySignal
    )
      return
    // Wait for an older request before reading the new watermark. A refetch
    // merged into that request could otherwise return its pre-reconnect state.
    requestedReplay.current = replaySignal
    void refetch()
  }, [active, isFetching, replaySignal, tabId, data?.recoveryGeneration, refetch])
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
    previous.current = {
      tabId,
      state,
      generation:
        data?.recoveryGeneration ?? (before?.tabId === tabId ? before.generation : undefined)
    }
    if (
      before?.tabId === tabId &&
      (before.state !== 'ready' ||
        (before.generation !== undefined &&
          data?.recoveryGeneration !== undefined &&
          before.generation !== data.recoveryGeneration)) &&
      state === 'ready' &&
      refreshing.current?.tabId !== tabId
    )
      reloadHistory()
  }, [active, tabId, data, error, reloadHistory])
  useEffect(() => {
    if (
      !active ||
      !historyReady ||
      error ||
      data?.state !== 'ready' ||
      refreshing.current?.tabId === tabId ||
      !hasPendingReplay() ||
      lastReplay.current?.generation !== data.recoveryGeneration
    )
      return
    // The first status can already include this recovery. The explicit signal
    // still proves history loaded earlier may have missed computer output.
    reloadHistory()
  }, [active, tabId, historyReady, data, error, replaySignal, hasPendingReplay, reloadHistory])
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
    void refreshAvailability({
      tabId,
      refetch,
      previous,
      refreshing,
      onRecovery: reloadHistory,
      hasPendingReplay
    })
  }, [
    active,
    tabId,
    historyReady,
    data?.state,
    error,
    isFetching,
    refetch,
    reloadHistory,
    hasPendingReplay
  ])
  const retry = useCallback(
    () => refreshAvailability({ tabId, refetch, previous, refreshing, onReady: reloadHistory }),
    [tabId, refetch, reloadHistory]
  )
  return { status: data ?? null, error: error ? error.message : null, retry }
}
