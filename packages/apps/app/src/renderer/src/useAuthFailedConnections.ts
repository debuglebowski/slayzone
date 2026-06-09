import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC, useTRPCClient, useSubscription } from '@slayzone/transport/client'
import type { IntegrationConnectionPublic } from '@slayzone/integrations/shared'

export interface AuthFailedConnection {
  connection: IntegrationConnectionPublic
  projectIds: string[]
}

// 2 min — react-query's window-focus refetch + the `notify.onTasksChanged`
// subscription catch any user-visible change near instantly, so the periodic
// poll is just a backstop.
const POLL_MS = 120_000

export function useAuthFailedConnections(): {
  failed: AuthFailedConnection[]
  refetch: () => void
} {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [failed, setFailed] = useState<AuthFailedConnection[]>([])

  // Backstop poll: only while the window is visible (refetchIntervalInBackground:
  // false), plus react-query's default window-focus refetch.
  const connectionsQuery = useQuery(
    trpc.integrations.listConnections.queryOptions(undefined, {
      refetchInterval: POLL_MS,
      refetchIntervalInBackground: false
    })
  )

  const refetch = (): void => void connectionsQuery.refetch()

  // Re-enrich whenever the connections list changes. The auth_error filter +
  // per-connection usage fan-out can't be expressed as a pure derivation, so it
  // runs imperatively and writes the enriched result into local state.
  useEffect(() => {
    const all = connectionsQuery.data
    if (!all) return
    let cancelled = false

    const enrich = async (): Promise<void> => {
      try {
        const flagged = all.filter((c) => Boolean(c.auth_error))
        if (flagged.length === 0) {
          if (!cancelled) setFailed((prev) => (prev.length === 0 ? prev : []))
          return
        }
        const enriched: AuthFailedConnection[] = await Promise.all(
          flagged.map(async (connection) => {
            const usage = await trpcClient.integrations.getConnectionUsage.query({
              connectionId: connection.id
            })
            return {
              connection,
              projectIds: usage.projects.filter((p) => p.has_mapping).map((p) => p.project_id)
            }
          })
        )
        if (!cancelled) setFailed(enriched.filter((f) => f.projectIds.length > 0))
      } catch {
        // ignore — banner just stays in last-known state
      }
    }

    void enrich()
    return () => {
      cancelled = true
    }
  }, [connectionsQuery.data, trpcClient])

  // `tasks:changed` fan-out — refetch the connections list when it fires.
  useSubscription(
    trpc.notify.onTasksChanged.subscriptionOptions(undefined, {
      onData: () => void connectionsQuery.refetch()
    })
  )

  return { failed, refetch }
}
