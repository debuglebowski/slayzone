import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'

export function useStaleSkillCounts(projects: ReadonlyArray<{ id: string; path: string | null }>): {
  counts: Map<string, number>
  refresh: () => void
} {
  const trpcClient = useTRPCClient()
  const [counts, setCounts] = useState<Map<string, number>>(() => new Map())
  const reqIdRef = useRef(0)

  const pairs = useMemo(
    () =>
      projects
        .filter((p): p is { id: string; path: string } => !!p.path)
        .map((p) => ({ projectId: p.id, projectPath: p.path })),
    [projects]
  )

  const refresh = useCallback(() => {
    if (pairs.length === 0) {
      setCounts(new Map())
      return
    }
    const reqId = ++reqIdRef.current
    trpcClient.aiConfig.getProjectsStaleSkillCounts
      .query(pairs)
      .then((rec) => {
        if (reqId !== reqIdRef.current) return
        setCounts(new Map(Object.entries(rec)))
      })
      .catch(() => {
        if (reqId === reqIdRef.current) setCounts(new Map())
      })
  }, [trpcClient, pairs])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  return { counts, refresh }
}
