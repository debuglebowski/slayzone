import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Polls the stale-skill count for the active project.
 * Event-driven: mount, project change, window focus, manual refresh.
 */
export function useStaleSkillCount(
  projectId: string | null | undefined,
  projectPath: string | null | undefined
): { count: number; refresh: () => void } {
  const [count, setCount] = useState(0)
  const reqIdRef = useRef(0)

  const refresh = useCallback(() => {
    if (!projectId || !projectPath) {
      setCount(0)
      return
    }
    const reqId = ++reqIdRef.current
    window.api.aiConfig
      .getProjectStaleSkillCount(projectId, projectPath)
      .then((n) => {
        if (reqId === reqIdRef.current) setCount(n)
      })
      .catch(() => {
        if (reqId === reqIdRef.current) setCount(0)
      })
  }, [projectId, projectPath])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  return { count, refresh }
}
