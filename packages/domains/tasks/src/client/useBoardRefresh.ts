import { useCallback, useRef, useState } from 'react'

export interface BoardRefreshTarget {
  label: string
  requests: Array<() => Promise<unknown>>
}

/** Wait for every hub independently so one offline hub never hides fresh rows. */
export function useBoardRefresh() {
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshErrors, setRefreshErrors] = useState<string[]>([])
  const pending = useRef<Promise<void> | null>(null)
  const refresh = useCallback((targets: BoardRefreshTarget[]): Promise<void> => {
    if (pending.current) return pending.current
    setIsRefreshing(true)
    setRefreshErrors([])
    const run = Promise.all(
      targets.map(async ({ label, requests }) => {
        const results = await Promise.allSettled(
          requests.map((request) => Promise.resolve().then(request))
        )
        return results.some((result) => result.status === 'rejected') ? label : null
      })
    )
      .then((failures) => {
        setRefreshErrors(failures.filter((label): label is string => label !== null))
      })
      .finally(() => {
        pending.current = null
        setIsRefreshing(false)
      })
    pending.current = run
    return run
  }, [])
  return { refresh, isRefreshing, refreshErrors }
}
