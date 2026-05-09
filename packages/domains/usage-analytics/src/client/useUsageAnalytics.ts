import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
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
  const [selectedProvider, setSelectedProvider] = useState<string>(ALL_PROVIDERS)
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([])
  const [defaultLoaded, setDefaultLoaded] = useState(false)

  const defaultModeQuery = useQuery(trpc.settings.get.queryOptions({ key: 'default_terminal_mode' }))
  const defaultMode = defaultModeQuery.data

  useEffect(() => {
    if (defaultModeQuery.isLoading) return
    window.api.terminalModes.list().then((modes) => {
      const options: ProviderOption[] = modes
        .filter((m) => m.enabled && m.id !== 'terminal')
        .map((m) => ({
          id: m.id,
          label: m.label,
          hasUsageData: PROVIDER_USAGE_SUPPORT[m.id]?.supported ?? false
        }))
      setProviderOptions(options)
      if (defaultMode && options.some((o) => o.id === defaultMode)) {
        setSelectedProvider(defaultMode)
      }
      setDefaultLoaded(true)
    }).catch(() => setDefaultLoaded(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultModeQuery.isLoading, defaultMode])

  const cachedQuery = useQuery({
    ...trpc.usageAnalytics.query.queryOptions(range),
    enabled: defaultLoaded,
  })

  const refreshMutation = useMutation(trpc.usageAnalytics.refresh.mutationOptions({
    onSuccess: (fresh) => {
      queryClient.setQueryData(trpc.usageAnalytics.query.queryKey(range), fresh)
    },
  }))

  // Trigger background refresh on range change after default loaded
  useEffect(() => {
    if (!defaultLoaded) return
    refreshMutation.mutate(range)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, defaultLoaded])

  const rawData = cachedQuery.data ?? EMPTY
  const loading = refreshMutation.isPending

  const providerSupported = selectedProvider === ALL_PROVIDERS ||
    (PROVIDER_USAGE_SUPPORT[selectedProvider]?.supported ?? false)

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
    const cacheHitPercent = totalInput > 0 ? (totalCacheReadTokens / (totalInput + totalCacheReadTokens)) * 100 : 0

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

  const refresh = async () => {
    await refreshMutation.mutateAsync(range)
  }

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
