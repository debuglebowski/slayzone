import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defaultProjectRoot, type Project } from '@slayzone/projects-contracts'
import { useTRPCClient } from './trpc'

type Pair = { projectId: string; projectPath: string }

interface CountScheduler {
  /** The projects listed now: projectId → path. */
  current: Map<string, string>
  /** What each held count was counted at (projectId → path), or is being counted at. */
  counted: Map<string, string>
  /** Asked for while a count runs: projectId → path. */
  queue: Map<string, string>
  running: boolean
}

/**
 * One count at a time; what was asked meanwhile goes in the next one. An answer is
 * kept only for projects still listed at the path it was counted at (a late result
 * can't bring back a removed count).
 */
function pump(
  sched: CountScheduler,
  query: (batch: Pair[]) => Promise<Record<string, number>>,
  setCounts: (update: (prev: Map<string, number>) => Map<string, number>) => void
): void {
  if (sched.running || sched.queue.size === 0) return
  const batch: Pair[] = [...sched.queue].map(([projectId, projectPath]) => ({
    projectId,
    projectPath
  }))
  sched.queue = new Map()
  sched.running = true
  const settle = (rec: Record<string, number> | null): void => {
    sched.running = false
    const still = batch.filter((p) => sched.current.get(p.projectId) === p.projectPath)
    if (still.length > 0) {
      setCounts((prev) => {
        const next = new Map(prev)
        for (const p of still) {
          const n = rec?.[p.projectId]
          if (n === undefined) next.delete(p.projectId)
          else next.set(p.projectId, n)
        }
        return next
      })
    }
    pump(sched, query, setCounts)
  }
  query(batch).then(settle, () => settle(null))
}

/**
 * Stale-skill counts per project, read from each project's folder on its computer.
 *
 * Each count checks every linked skill file on the project's computer, one round
 * trip per file, so this counts as little as it can:
 *  - keyed by content, not by the array: callers rebuild their project list on
 *    every task change (the sidebar does — a chat starting changes its task several
 *    times), and an equal list counts nothing;
 *  - only projects new to the list (or at another path) are counted; the others
 *    keep their count. `refresh()` (and window focus) counts every project again;
 *  - one count runs at a time; what is asked meanwhile is counted together, once,
 *    when it ends.
 * Every project file check used to be an in-process read; since project files live
 * on their computer, recounting on every task change flooded the computer link
 * while chats started.
 */
export function useStaleSkillCounts(
  projects: ReadonlyArray<Pick<Project, 'id' | 'placements' | 'resolved_computer_id'>>
): {
  counts: Map<string, number>
  refresh: () => void
} {
  const trpcClient = useTRPCClient()
  const [counts, setCounts] = useState<Map<string, number>>(() => new Map())

  const key = JSON.stringify(
    projects.flatMap((p) => {
      const projectPath = defaultProjectRoot(p)
      return projectPath ? [[p.id, projectPath]] : []
    })
  )
  const pairs = useMemo(
    () =>
      (JSON.parse(key) as Array<[string, string]>).map(
        ([projectId, projectPath]): Pair => ({ projectId, projectPath })
      ),
    [key]
  )

  const schedRef = useRef<CountScheduler>({
    current: new Map(),
    counted: new Map(),
    queue: new Map(),
    running: false
  })

  const ask = useCallback(
    (wanted: readonly Pair[]): void => {
      const sched = schedRef.current
      for (const p of wanted) {
        sched.queue.set(p.projectId, p.projectPath)
        sched.counted.set(p.projectId, p.projectPath)
      }
      pump(
        sched,
        (batch) => trpcClient.aiConfig.getProjectsStaleSkillCounts.query(batch),
        setCounts
      )
    },
    [trpcClient]
  )

  // The list changed (by content): forget who left, count who is new or moved.
  useEffect(() => {
    const sched = schedRef.current
    const current = new Map(pairs.map((p) => [p.projectId, p.projectPath]))
    sched.current = current
    for (const [id, at] of sched.counted) if (current.get(id) !== at) sched.counted.delete(id)
    for (const [id, at] of sched.queue) if (current.get(id) !== at) sched.queue.delete(id)
    ask(pairs.filter((p) => sched.counted.get(p.projectId) !== p.projectPath))
  }, [pairs, ask])

  const refresh = useCallback(() => ask(pairs), [ask, pairs])

  useEffect(() => {
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  // Only listed projects: a project that left keeps no count (held until it is
  // listed again and recounted).
  const listed = useMemo(() => {
    const ids = new Set(pairs.map((p) => p.projectId))
    return [...counts.keys()].every((id) => ids.has(id))
      ? counts
      : new Map([...counts].filter(([id]) => ids.has(id)))
  }, [counts, pairs])

  return { counts: listed, refresh }
}
