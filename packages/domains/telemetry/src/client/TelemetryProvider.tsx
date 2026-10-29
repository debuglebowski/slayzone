import { createContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { useTRPC } from './trpc'
import { useQuery, useMutation } from '@tanstack/react-query'
import { parseTelemetryTier, type TelemetryTier } from '../shared/types'
import {
  applyTelemetryTier,
  track,
  stopHeartbeat,
  stopIpcTelemetryBridge,
  getPosthogInstance
} from './telemetry'
import { useHubsPermitTelemetry } from './useHubsPermitTelemetry'

const SETTINGS_KEY = 'telemetry_tier'

/**
 * May this renderer use third-party services — PostHog and Convex (leaderboard,
 * feedback)? `pending` until the stored tier and every hub's answer are known; nothing
 * starts before `allowed` (fail closed).
 */
export type ThirdPartyServices = 'pending' | 'allowed' | 'blocked'

interface TelemetryContextValue {
  /** The tier in force: `off` when a hub forbids telemetry, else the user's choice. */
  tier: TelemetryTier
  setTier: (tier: TelemetryTier) => void
  track: typeof track
  /**
   * A connected hub has `SLAYZONE_HUB_ENABLE_TELEMETRY=0`, or could not be asked (fail
   * closed): `tier` is `off` and the user cannot change it.
   */
  lockedByHub: boolean
  thirdPartyServices: ThirdPartyServices
}

export const TelemetryContext = createContext<TelemetryContextValue>({
  tier: 'anonymous',
  setTier: () => {
    // Default for consumers rendered outside TelemetryProvider (unit tests, the
    // fork's partial shells). There is no persisted tier to write, so dropping
    // the change is correct — the provider supplies the real setter.
  },
  track,
  lockedByHub: false,
  // No provider, no answer from any hub: nothing third-party starts (fail closed).
  thirdPartyServices: 'blocked'
})

export function TelemetryProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC()
  const [storedTier, setStoredTier] = useState<TelemetryTier>('anonymous')
  const [initDone, setInitDone] = useState(false)
  const marksRef = useRef(false)
  const versionAppliedRef = useRef(false)

  const tierSetting = useQuery(trpc.settings.get.queryOptions({ key: SETTINGS_KEY }))
  const { mutate: setTierSetting } = useMutation(trpc.settings.set.mutationOptions())
  const hubsPermit = useHubsPermitTelemetry()

  // Version fetched once PostHog has started. Mirrors the original nested
  // getVersion() call that ran after initTelemetry.
  const versionQuery = useQuery(
    trpc.app.meta.getVersion.queryOptions(undefined, { enabled: initDone })
  )

  // Adopt the persisted tier once, the first time it resolves — adjusted during
  // render. A later change of the stored value is not re-adopted.
  const [tierHydrated, setTierHydrated] = useState(false)
  if (!tierHydrated && tierSetting.isSuccess) {
    setTierHydrated(true)
    setStoredTier(parseTelemetryTier(tierSetting.data))
  }

  const lockedByHub = hubsPermit === false
  const tier: TelemetryTier = lockedByHub ? 'off' : storedTier
  // Both answers are in, or one of them already says no.
  const known = (tierHydrated && hubsPermit !== null) || lockedByHub
  const thirdPartyServices: ThirdPartyServices = !known
    ? tierHydrated && storedTier === 'off'
      ? 'blocked'
      : 'pending'
    : tier === 'off'
      ? 'blocked'
      : 'allowed'

  // PostHog follows the tier in force, from the moment it is known: started, switched
  // between anonymous and opted-in, or stopped (`off` never loads it at all).
  useEffect(() => {
    if (!known) return
    const firstApply = !marksRef.current
    marksRef.current = true
    if (firstApply) performance.mark('sz:telemetry:start')
    void applyTelemetryTier(tier).then(() => {
      if (firstApply) performance.mark('sz:telemetry:end')
      if (tier !== 'off') setInitDone(true)
    })
  }, [known, tier])

  // Register app_version + emit app_opened once PostHog has started and the version is in.
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
      // A hub that forbids telemetry decides; the stored choice would not apply anyway.
      if (lockedByHub) return
      setStoredTier(newTier)
      setTierSetting({ key: SETTINGS_KEY, value: newTier })
    },
    [lockedByHub, setTierSetting]
  )

  return (
    <TelemetryContext.Provider
      value={{ tier, setTier: changeTier, track, lockedByHub, thirdPartyServices }}
    >
      {children}
    </TelemetryContext.Provider>
  )
}
