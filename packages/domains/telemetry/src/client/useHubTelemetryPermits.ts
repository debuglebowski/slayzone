import { useEffect, useState } from 'react'
import { hubPermitsTelemetry, useFederationOrNull, useHubId } from '@slayzone/transport/client'
import { useTRPCClient } from './trpc'

export interface HubTelemetryPermits {
  /**
   * The home hub — the hub of the nearest tRPC client, where this app's own data lives
   * (the desktop's default hub, the web shell's serving hub). null until it has answered.
   * `false` turns telemetry off for the whole app: PostHog, the leaderboard, feedback.
   */
  home: boolean | null
  /** Its id: the nearest HubScope's, else the registry default; null with no registry. */
  homeHubId: string | null
  /**
   * Every OTHER hub in the registry, by id. `false` withholds only the events about that
   * hub's own tasks and projects; `null` = not answered yet.
   */
  others: ReadonlyMap<string, boolean | null>
}

/**
 * Each hub's `SLAYZONE_HUB_ENABLE_TELEMETRY` (from `hub.describe`), the home hub apart
 * from the others: a hub decides about ITS data only. With federation (desktop) the
 * others are every registry hub — `PtyProvider` connects to each at boot anyway; the web
 * shell and the fork have none.
 *
 * A hub that cannot answer counts as forbidding it (`hubPermitsTelemetry` fails closed);
 * the hubs are asked again whenever the registry changes (a sign-in's fresh token). The
 * previous answer stands meanwhile, so a re-ask never flickers telemetry — and the
 * Convex session — off and back on.
 */
export function useHubTelemetryPermits(): HubTelemetryPermits {
  const federation = useFederationOrNull()
  const client = useTRPCClient()
  const homeHubId = useHubId() ?? federation?.defaultHubId ?? null
  const [home, setHome] = useState<boolean | null>(null)
  // Answers by hub id. Kept across re-asks; a hub that left the registry is simply
  // no longer read (`others` below).
  const [answers, setAnswers] = useState<ReadonlyMap<string, boolean>>(new Map())

  useEffect(() => {
    let cancelled = false
    void hubPermitsTelemetry(client).then((permits) => {
      if (!cancelled) setHome(permits)
    })
    for (const hub of federation?.hubs ?? []) {
      if (hub.id === homeHubId) continue
      // An entry the registry cannot resolve (no url yet) has no client to ask: it stays
      // unanswered, i.e. withheld.
      const resolved = federation?.resolve(hub.id)
      if (!resolved) continue
      void hubPermitsTelemetry(resolved.ws.client).then((permits) => {
        if (!cancelled) setAnswers((prev) => new Map(prev).set(hub.id, permits))
      })
    }
    return () => {
      cancelled = true
    }
  }, [federation, client, homeHubId])

  const others = new Map<string, boolean | null>()
  for (const hub of federation?.hubs ?? []) {
    if (hub.id !== homeHubId) others.set(hub.id, answers.get(hub.id) ?? null)
  }
  return { home, homeHubId, others }
}
