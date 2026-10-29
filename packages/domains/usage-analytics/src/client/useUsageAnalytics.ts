import { useState, useEffect, useCallback, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from './trpc'
import type { AnalyticsSummary, DateRange, ProviderOption } from '../shared/types'
import { PROVIDER_USAGE_SUPPORT, ALL_PROVIDERS } from '../shared/types'

const EMPTY: AnalyticsSummary = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  totalSessions: 0,
  cacheHitPercent: 0,
  byProvider: [],
  byModel: [],
  byDay: [],
  byTask: []
}

export function useUsageAnalytics() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [range, setRange] = useState<DateRange>('30d')
  // The provider the user picked in the filter; null until they pick one.
  const [pickedProvider, setSelectedProvider] = useState<string | null>(null)

  // Enabled modes + persisted default provider.
  const modesQuery = useQuery(trpc.pty.modesList.queryOptions())
  const defaultModeQuery = useQuery(
    trpc.settings.get.queryOptions({ key: 'default_terminal_mode' })
  )
  const settingsLoaded = modesQuery.isSuccess && defaultModeQuery.isSuccess

  const providerOptions = useMemo<ProviderOption[]>(() => {
    return (modesQuery.data ?? [])
      .filter((m) => m.enabled && m.id !== 'terminal')
      .map((m) => ({
        id: m.id,
        label: m.label,
        hasUsageData: PROVIDER_USAGE_SUPPORT[m.id]?.supported ?? false
      }))
  }, [modesQuery.data])

  // Until the user picks one, the filter shows the persisted default agent — once
  // options + default load, and only while it is an enabled agent; else "All".
  const defaultMode = defaultModeQuery.data
  const defaultProvider =
    settingsLoaded && defaultMode && providerOptions.some((o) => o.id === defaultMode)
      ? defaultMode
      : ALL_PROVIDERS
  const selectedProvider = pickedProvider ?? defaultProvider

  const providerSupported =
    selectedProvider === ALL_PROVIDERS ||
    (PROVIDER_USAGE_SUPPORT[selectedProvider]?.supported ?? false)

  // Cached analytics — instant display; refetches when range changes.
  const analyticsQuery = useQuery(
    trpc.usageAnalytics.query.queryOptions(range, { enabled: settingsLoaded })
  )
  const rawData = analyticsQuery.data ?? EMPTY

  // Background refresh — recompute fresh data, write it into the cached query.
  const {
    mutate: refreshInBackground,
    mutateAsync: refreshNow,
    isPending: loading
  } = useMutation(
    trpc.usageAnalytics.refresh.mutationOptions({
      onSuccess: (fresh) => {
        queryClient.setQueryData(trpc.usageAnalytics.query.queryKey(range), fresh)
      }
    })
  )

  // Auto background-refresh whenever the range becomes active / changes
  // (mirrors the old cached-then-fresh load).
  useEffect(() => {
    if (settingsLoaded) refreshInBackground(range)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, settingsLoaded])

  // Filtered view
  const data = useMemo(() => {
    if (selectedProvider === ALL_PROVIDERS) return rawData

    const byProvider = rawData.byProvider.filter((p) => p.provider === selectedProvider)
    const byDay = rawData.byDay.filter((d) => d.provider === selectedProvider)
    const byModel = rawData.byModel.filter((m) => m.provider === selectedProvider)
    const byTask = rawData.byTask.filter((t) => t.provider === selectedProvider)

    const totalInputTokens = byProvider.reduce((s, p) => s + p.inputTokens, 0)
    const totalOutputTokens = byProvider.reduce((s, p) => s + p.outputTokens, 0)
    const totalCacheReadTokens = byProvider.reduce((s, p) => s + p.cacheReadTokens, 0)
    const totalCacheWriteTokens = byProvider.reduce((s, p) => s + p.cacheWriteTokens, 0)
    const totalSessions = byProvider.reduce((s, p) => s + p.sessions, 0)
    const totalInput = totalInputTokens + totalCacheWriteTokens
    const cacheHitPercent =
      totalInput > 0 ? (totalCacheReadTokens / (totalInput + totalCacheReadTokens)) * 100 : 0

    return {
      ...rawData,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheWriteTokens,
      totalSessions,
      cacheHitPercent,
      byProvider,
      byModel,
      byDay,
      byTask
    }
  }, [rawData, selectedProvider])

  const refresh = useCallback(async () => {
    try {
      await refreshNow(range)
    } catch {
      /* swallow — matches the old refresh's finally-only handling */
    }
  }, [range, refreshNow])

  return {
    data,
    range,
    setRange,
    loading,
    refresh,
    selectedProvider,
    setSelectedProvider,
    providerSupported,
    providerOptions
  }
}
