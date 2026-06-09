import {
  createContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode
} from 'react'
import { useTRPC } from '@slayzone/transport/client'
import { useQuery, useMutation } from '@tanstack/react-query'
import type { TelemetryTier } from '../shared/types'
import {
  initTelemetry,
  setTelemetryTier as setTelemetryTierInternal,
  track,
  startHeartbeat,
  stopHeartbeat,
  startIpcTelemetryBridge,
  stopIpcTelemetryBridge,
  getPosthogInstance
} from './telemetry'

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
  const [tier, setTier] = useState<TelemetryTier>('anonymous')
  const [initDone, setInitDone] = useState(false)
  const initializedRef = useRef(false)
  const versionAppliedRef = useRef(false)

  const tierSetting = useQuery(trpc.settings.get.queryOptions({ key: SETTINGS_KEY }))
  const setTierMutation = useMutation(trpc.settings.set.mutationOptions())

  // Version fetched once init has completed (posthog may have loaded). Mirrors
  // the original nested getVersion() call that ran after initTelemetry.
  const versionQuery = useQuery(
    trpc.app.meta.getVersion.queryOptions(undefined, { enabled: initDone })
  )

  // Init sequence — runs exactly once, after the persisted tier resolves.
  useEffect(() => {
    if (initializedRef.current) return
    if (!tierSetting.isSuccess) return
    initializedRef.current = true

    performance.mark('sz:telemetry:start')
    const stored = tierSetting.data
    const t: TelemetryTier = stored === 'opted_in' ? 'opted_in' : 'anonymous'
    setTier(t)
    void (async () => {
      await initTelemetry(t)
      performance.mark('sz:telemetry:end')
      startHeartbeat()
      startIpcTelemetryBridge()
      setInitDone(true)
    })()
  }, [tierSetting.isSuccess, tierSetting.data])

  // Register app_version + emit app_opened once both init + version are ready.
  useEffect(() => {
    if (versionAppliedRef.current) return
    if (!initDone || versionQuery.data === undefined) return
    versionAppliedRef.current = true
    const version = versionQuery.data
    void (async () => {
      const ph = await getPosthogInstance()
      if (ph) {
        ph.register({ app_version: version })
        track('app_opened', { version })
      }
    })()
  }, [initDone, versionQuery.data])

  useEffect(() => {
    return () => {
      stopHeartbeat()
      stopIpcTelemetryBridge()
    }
  }, [])

  const changeTier = useCallback(
    (newTier: TelemetryTier) => {
      setTier(newTier)
      setTelemetryTierInternal(newTier)
      setTierMutation.mutate({ key: SETTINGS_KEY, value: newTier })
    },
    [setTierMutation]
  )

  return (
    <TelemetryContext.Provider value={{ tier, setTier: changeTier, track }}>
      {children}
    </TelemetryContext.Provider>
  )
}
