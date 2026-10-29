import { useCallback, useEffect, useRef, useState } from 'react'
import { useTRPCClient } from './trpc'

/**
 * Polls the stale-skill count for the active project.
 * Event-driven: mount, project change, window focus, manual refresh.
 */
export function useStaleSkillCount(
  projectId: string | null | undefined,
  projectPath: string | null | undefined
): { count: number; refresh: () => void } {
  const trpcClient = useTRPCClient()
  const [count, setCount] = useState(0)
  const reqIdRef = useRef(0)

  // Query + apply the count; no query without a project. Every call supersedes the
  // request in flight — the no-project one too, so a late result for the previous
  // project can't overwrite the zero.
  const fetchCount = useCallback(() => {
    const reqId = ++reqIdRef.current
    if (!projectId || !projectPath) return
    trpcClient.aiConfig.getProjectStaleSkillCount
      .query({ projectId, projectPath })
      .then((n) => {
        if (reqId === reqIdRef.current) setCount(n)
      })
      .catch(() => {
        if (reqId === reqIdRef.current) setCount(0)
      })
  }, [trpcClient, projectId, projectPath])

  const refresh = useCallback(() => {
    if (!projectId || !projectPath) setCount(0)
    fetchCount()
  }, [projectId, projectPath, fetchCount])

  // Without a project, each change of inputs zeroes the count (with one, the effect
  // below fetches) — adjusted while rendering. `zeroedFor` holds the inputs last
  // zeroed for and is cleared once a project is set, so switching between projects
  // costs no extra render pass. Mounting without a project needs nothing: count
  // starts at 0.
  const noProject = !projectId || !projectPath
  const inputs = [trpcClient, projectId, projectPath]
  const [zeroedFor, setZeroedFor] = useState<readonly unknown[] | null>(() =>
    noProject ? inputs : null
  )
  if (noProject) {
    if (!zeroedFor || inputs.some((v, i) => !Object.is(v, zeroedFor[i]))) {
      setZeroedFor(inputs)
      setCount(0)
    }
  } else if (zeroedFor) {
    setZeroedFor(null)
  }

  useEffect(() => {
    fetchCount()
  }, [fetchCount])

  useEffect(() => {
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  return { count, refresh }
}
