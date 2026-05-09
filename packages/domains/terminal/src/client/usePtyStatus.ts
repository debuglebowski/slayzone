import { useState, useEffect, useCallback } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'

/**
 * Returns Set of sessionIds with alive PTY sessions
 */
export function usePtyStatus(): Set<string> {
  const trpcClient = useTRPCClient()
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    const list = await trpcClient.pty.list.query()
    const active = new Set(list.filter((p) => p.state !== 'dead').map((p) => p.sessionId))
    setActiveSessionIds(active)
  }, [trpcClient])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    const interval = setInterval(refresh, 5000)
    return () => clearInterval(interval)
  }, [refresh])

  return activeSessionIds
}
