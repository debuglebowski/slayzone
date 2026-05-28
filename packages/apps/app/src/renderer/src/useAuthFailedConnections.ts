import { useCallback, useEffect, useState } from 'react'
import type { IntegrationConnectionPublic } from '@slayzone/integrations/shared'

export interface AuthFailedConnection {
  connection: IntegrationConnectionPublic
  projectIds: string[]
}

const POLL_MS = 60_000

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
            projectIds: usage.projects.map((p) => p.project_id)
          }
        })
      )
      setFailed(enriched)
    } catch {
      // ignore — banner just stays in last-known state
    }
  }, [])

  useEffect(() => {
    void refetch()
    const onFocus = (): void => void refetch()
    window.addEventListener('focus', onFocus)
    const interval = setInterval(() => void refetch(), POLL_MS)
    const unsub = window.api?.app?.onTasksChanged?.(() => void refetch())
    return () => {
      window.removeEventListener('focus', onFocus)
      clearInterval(interval)
      unsub?.()
    }
  }, [refetch])

  return { failed, refetch: () => void refetch() }
}
