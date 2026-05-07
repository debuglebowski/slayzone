import { useState, useEffect, useCallback, useMemo } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
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
  const [range, setRange] = useState<DateRange>('30d')
  const [rawData, setRawData] = useState<AnalyticsSummary>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<string>(ALL_PROVIDERS)
  const [defaultLoaded, setDefaultLoaded] = useState(false)
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([])

  // Load enabled modes + default provider from settings on mount
  useEffect(() => {
    Promise.all([
      window.api.settings.get('default_terminal_mode'),
      window.api.terminalModes.list()
    ]).then(([defaultMode, modes]) => {
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
  }, [])

  const providerSupported = selectedProvider === ALL_PROVIDERS ||
    (PROVIDER_USAGE_SUPPORT[selectedProvider]?.supported ?? false)

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

  // Show cached data instantly, then refresh in background
  useEffect(() => {
    if (!defaultLoaded) return
    let cancelled = false

    getTrpcVanillaClient().usageAnalytics.query.query(range).then((cached) => {
      if (!cancelled) setRawData(cached)
    })

    setLoading(true)
    getTrpcVanillaClient().usageAnalytics.refresh.mutate(range).then((fresh) => {
      if (!cancelled) {
        setRawData(fresh)
        setLoading(false)
      }
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  }, [range, defaultLoaded])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await getTrpcVanillaClient().usageAnalytics.refresh.mutate(range)
      setRawData(result)
    } finally {
      setLoading(false)
    }
  }, [range])

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
