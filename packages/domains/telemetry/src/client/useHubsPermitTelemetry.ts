import { useEffect, useState } from 'react'
import { hubPermitsTelemetry, useFederationOrNull } from '@slayzone/transport/client'
import { useTRPCClient } from './trpc'

/**
 * Does EVERY hub this renderer talks to permit third-party telemetry
 * (`SLAYZONE_HUB_ENABLE_TELEMETRY`, from `hub.describe`)? null until all have answered.
 *
 * Every hub, not only the default one: the app's PostHog stream and its Convex session
 * are app-wide, so one hub with telemetry off turns both off for the whole app. With
 * federation (desktop) that is every hub in the registry — `PtyProvider` connects to each
 * at boot anyway — plus, always, the hub of the nearest tRPC provider (the only one in the
 * web shell and the fork).
 *
 * A hub that cannot answer counts as forbidding it (`hubPermitsTelemetry` fails closed);
 * the hubs are asked again whenever the registry changes (a sign-in's fresh token). The
 * previous answer stands meanwhile, so a re-ask never flickers telemetry — and the
 * Convex session — off and back on.
 */
export function useHubsPermitTelemetry(): boolean | null {
  const federation = useFederationOrNull()
  const client = useTRPCClient()
  const [permits, setPermits] = useState<boolean | null>(null)

  useEffect(() => {
    // The nearest client always (the default hub's), then every registry hub; a Set
    // because the default hub's federation entry is that same client.
    const clients = new Set<Parameters<typeof hubPermitsTelemetry>[0]>([client])
    for (const hub of federation?.hubs ?? []) {
      const resolved = federation?.resolve(hub.id)
      if (resolved) clients.add(resolved.ws.client)
    }
    let cancelled = false
    void Promise.all([...clients].map((c) => hubPermitsTelemetry(c))).then((answers) => {
      if (!cancelled) setPermits(answers.every(Boolean))
    })
    return () => {
      cancelled = true
    }
  }, [federation, client])

  return permits
}
