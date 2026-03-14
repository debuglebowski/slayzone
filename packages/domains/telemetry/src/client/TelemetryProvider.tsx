import { createContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import type { TelemetryTier } from '../shared/types'
import { initTelemetry, setTelemetryTier as setTelemetryTierInternal, track, startHeartbeat, stopHeartbeat, getPosthogInstance } from './telemetry'

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [posthogProvider, setPosthogProvider] = useState<{ Provider: React.ComponentType<any>; client: unknown } | null>(null)
  const initializedRef = useRef(false)

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    window.api.settings.get(SETTINGS_KEY).then(async (stored) => {
      const t: TelemetryTier = stored === 'opted_in' ? 'opted_in' : 'anonymous'
      setTier(t)
      await initTelemetry(t)
      startHeartbeat()

      const ph = await getPosthogInstance()
      if (ph) {
        window.api.app.getVersion().then((version) => {
          ph.register({ app_version: version })
          track('app_opened', { version })
        })

        // Lazy-load PostHogProvider wrapper
        const { PostHogProvider } = await import('@posthog/react')
        setPosthogProvider({ Provider: PostHogProvider, client: ph })
      }
    })

    return () => stopHeartbeat()
  }, [])

  const changeTier = useCallback((newTier: TelemetryTier) => {
    setTier(newTier)
    setTelemetryTierInternal(newTier)
    window.api.settings.set(SETTINGS_KEY, newTier)
  }, [])

  const inner = posthogProvider
    ? <posthogProvider.Provider client={posthogProvider.client}>{children}</posthogProvider.Provider>
    : children

  return (
    <TelemetryContext.Provider value={{ tier, setTier: changeTier, track }}>
      {inner}
    </TelemetryContext.Provider>
  )
}
