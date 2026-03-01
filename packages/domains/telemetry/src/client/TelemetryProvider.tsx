import { createContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import posthog from 'posthog-js'
import { PostHogProvider } from '@posthog/react'
import type { TelemetryTier } from '../shared/types'
import { initTelemetry, setTelemetryTier as setTelemetryTierInternal, track, startHeartbeat, stopHeartbeat } from './telemetry'

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
  const [ready, setReady] = useState(false)
  const initializedRef = useRef(false)

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    ;(async () => {
      try {
        const stored = await window.api.settings.get(SETTINGS_KEY)
        const t: TelemetryTier = stored === 'opted_in' ? 'opted_in' : 'anonymous'
        setTier(t)
        initTelemetry(t)
        startHeartbeat()
        setReady(true)

        const version = await window.api.app.getVersion()
        track('app_opened', { version })
      } catch {
        // Telemetry init failed — continue without it
        setReady(true)
      }
    })()

    return () => stopHeartbeat()
  }, [])

  const changeTier = useCallback((newTier: TelemetryTier) => {
    setTier(newTier)
    setTelemetryTierInternal(newTier)
    window.api.settings.set(SETTINGS_KEY, newTier)
  }, [])

  return (
    <TelemetryContext.Provider value={{ tier, setTier: changeTier, track }}>
      {ready ? (
        <PostHogProvider client={posthog}>{children}</PostHogProvider>
      ) : (
        children
      )}
    </TelemetryContext.Provider>
  )
}
