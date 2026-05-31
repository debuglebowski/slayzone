import { useCallback, useEffect, useState } from 'react'
import { useVisibleInterval } from '@slayzone/ui'
import type { IntegrationConnectionPublic } from '@slayzone/integrations/shared'

export interface AuthFailedConnection {
  connection: IntegrationConnectionPublic
  projectIds: string[]
}

// 2 min — `focus` + `tasks:changed` IPC catch any user-visible change near
// instantly, so the periodic poll is just a backstop.
const POLL_MS = 120_000

export function useAuthFailedConnections(): {
  failed: AuthFailedConnection[]
  refetch: () => void
} {
  const [failed, setFailed] = useState<AuthFailedConnection[]>([])

  const refetch = useCallback(async () => {
    try {
      const all = await window.api.integrations.listConnections()
      const flagged = all.filter((c) => Boolean(c.auth_error))
      if (flagged.length === 0) {
        setFailed((prev) => (prev.length === 0 ? prev : []))
        return
      }
      const enriched: AuthFailedConnection[] = await Promise.all(
        flagged.map(async (connection) => {
          const usage = await window.api.integrations.getConnectionUsage(connection.id)
          return {
            connection,
            projectIds: usage.projects.filter((p) => p.has_mapping).map((p) => p.project_id)
          }
        })
      )
      setFailed(enriched.filter((f) => f.projectIds.length > 0))
    } catch {
      // ignore — banner just stays in last-known state
    }
  }, [])

  useEffect(() => {
    void refetch()
    const onFocus = (): void => void refetch()
    window.addEventListener('focus', onFocus)
    const unsub = window.api?.app?.onTasksChanged?.(() => void refetch())
    return () => {
      window.removeEventListener('focus', onFocus)
      unsub?.()
    }
  }, [refetch])

  useVisibleInterval(() => void refetch(), POLL_MS)

  return { failed, refetch: () => void refetch() }
}
