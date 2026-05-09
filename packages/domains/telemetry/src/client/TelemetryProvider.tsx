import { createContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { TelemetryTier } from '../shared/types'
import { initTelemetry, setTelemetryTier as setTelemetryTierInternal, track, startHeartbeat, stopHeartbeat, startIpcTelemetryBridge, stopIpcTelemetryBridge, getPosthogInstance } from './telemetry'

const SETTINGS_KEY = 'telemetry_tier'

interface TelemetryContextValue {
  tier: TelemetryTier
  setTier: (tier: TelemetryTier) => void
  track: typeof track
}

export const TelemetryContext = createContext<TelemetryContextValue>({
  tier: 'anonymous',
  setTier: () => {},
  track
})

export function TelemetryProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC()
  const tierQuery = useQuery(trpc.settings.get.queryOptions({ key: SETTINGS_KEY }))
  const appVersionQuery = useQuery(trpc.app.meta.getVersion.queryOptions())
  const setSettingMutation = useMutation(trpc.settings.set.mutationOptions())
  const [tier, setTier] = useState<TelemetryTier>('anonymous')
  const initializedRef = useRef(false)

  useEffect(() => {
    if (initializedRef.current) return
    if (tierQuery.isLoading) return
    initializedRef.current = true

    performance.mark('sz:telemetry:start')
    const t: TelemetryTier = tierQuery.data === 'opted_in' ? 'opted_in' : 'anonymous'
    setTier(t)
    void (async () => {
      await initTelemetry(t)
      performance.mark('sz:telemetry:end')
      startHeartbeat()
      startIpcTelemetryBridge()

      const ph = await getPosthogInstance()
      if (!ph) return
      // Wait for version (already fetching via useQuery)
      let version = appVersionQuery.data
      if (!version) {
        // Poll until query resolves (one-shot init)
        version = await new Promise<string>((resolve) => {
          const id = setInterval(() => {
            if (appVersionQuery.data) {
              clearInterval(id)
              resolve(appVersionQuery.data)
            }
          }, 50)
        })
      }
      ph.register({ app_version: version })
      track('app_opened', { version })
    })()

    return () => { stopHeartbeat(); stopIpcTelemetryBridge() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tierQuery.isLoading])

  const changeTier = useCallback((newTier: TelemetryTier) => {
    setTier(newTier)
    setTelemetryTierInternal(newTier)
    setSettingMutation.mutate({ key: SETTINGS_KEY, value: newTier })
  }, [setSettingMutation])

  return (
    <TelemetryContext.Provider value={{ tier, setTier: changeTier, track }}>
      {children}
    </TelemetryContext.Provider>
  )
}
