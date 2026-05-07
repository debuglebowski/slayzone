import { createContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
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
  const [tier, setTier] = useState<TelemetryTier>('anonymous')
  const initializedRef = useRef(false)

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    performance.mark('sz:telemetry:start')
    getTrpcVanillaClient().settings.get.query({ key: SETTINGS_KEY }).then(async (stored) => {
      const t: TelemetryTier = stored === 'opted_in' ? 'opted_in' : 'anonymous'
      setTier(t)
      await initTelemetry(t)
      performance.mark('sz:telemetry:end')
      startHeartbeat()
      startIpcTelemetryBridge()

      const ph = await getPosthogInstance()
      if (ph) {
        window.api.app.getVersion().then((version) => {
          ph.register({ app_version: version })
          track('app_opened', { version })
        })
      }
    })

    return () => { stopHeartbeat(); stopIpcTelemetryBridge() }
  }, [])

  const changeTier = useCallback((newTier: TelemetryTier) => {
    setTier(newTier)
    setTelemetryTierInternal(newTier)
    getTrpcVanillaClient().settings.set.mutate({ key: SETTINGS_KEY, value: newTier })
  }, [])

  return (
    <TelemetryContext.Provider value={{ tier, setTier: changeTier, track }}>
      {children}
    </TelemetryContext.Provider>
  )
}
