import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'

/**
 * Returns Set of sessionIds with alive PTY sessions
 */
export function usePtyStatus(): Set<string> {
  const trpc = useTRPC()
  const { data } = useQuery({
    ...trpc.pty.list.queryOptions(),
    refetchInterval: 5000,
  })
  return useMemo(() => {
    if (!data) return new Set<string>()
    return new Set(data.filter((p) => p.state !== 'dead').map((p) => p.sessionId))
  }, [data])
}
