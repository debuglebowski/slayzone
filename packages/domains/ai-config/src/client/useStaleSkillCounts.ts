import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTRPCClient } from './trpc'

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

  // Query + apply the counts; no query without any project path. Every call
  // supersedes the request in flight — the no-path one too, so a late result for
  // the previous projects can't overwrite the cleared counts.
  const fetchCounts = useCallback(() => {
    const reqId = ++reqIdRef.current
    if (pairs.length === 0) return
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

  const refresh = useCallback(() => {
    if (pairs.length === 0) setCounts(new Map())
    fetchCounts()
  }, [pairs, fetchCounts])

  // With no project path, each change of inputs clears the counts (otherwise the
  // effect below fetches) — adjusted while rendering. `clearedFor` holds the inputs
  // last cleared for and is reset once there are paths again, so a changing
  // project list costs no extra render pass. Mounting without paths needs nothing:
  // counts start empty.
  const noPaths = pairs.length === 0
  const inputs = [trpcClient, pairs]
  const [clearedFor, setClearedFor] = useState<readonly unknown[] | null>(() =>
    noPaths ? inputs : null
  )
  if (noPaths) {
    if (!clearedFor || inputs.some((v, i) => !Object.is(v, clearedFor[i]))) {
      setClearedFor(inputs)
      setCounts(new Map())
    }
  } else if (clearedFor) {
    setClearedFor(null)
  }

  useEffect(() => {
    fetchCounts()
  }, [fetchCounts])

  useEffect(() => {
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  return { counts, refresh }
}
