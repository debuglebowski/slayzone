import { useState, useEffect, useCallback } from 'react'
import { useVisibleInterval } from '@slayzone/ui'
import type { ProviderUsage } from '@slayzone/terminal/shared'

const POLL_INTERVAL = 5 * 60_000

export function useUsage() {
  const [data, setData] = useState<ProviderUsage[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (force?: boolean) => {
    try {
      const result = await window.api.usage.fetch(force)
      setData(result)
    } catch {
      // silent — stale data is fine
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useVisibleInterval(() => void refresh(), POLL_INTERVAL, { runOnVisible: true })

  return { data, loading, refresh }
}
