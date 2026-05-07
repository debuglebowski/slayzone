import { useState, useEffect, useCallback } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import type { ProviderUsage } from '@slayzone/terminal/shared'

const POLL_INTERVAL = 5 * 60_000

export function useUsage() {
  const [data, setData] = useState<ProviderUsage[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (force?: boolean) => {
    try {
      const result = await getTrpcVanillaClient().app.usage.fetch.query({ force })
      setData(result)
    } catch {
      // silent — stale data is fine
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_INTERVAL)
    return () => clearInterval(id)
  }, [refresh])

  return { data, loading, refresh }
}
