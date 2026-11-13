import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from './trpc'

const EMPTY: ReadonlySet<string> = new Set()
const FaultedTasksContext = createContext<ReadonlySet<string>>(EMPTY)

/**
 * Tasks with a Needs-attention fault (decision 6: the task badge). One query for
 * the whole board; cards read it through context, so only their badge depends on it.
 */
export function FaultedTasksProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC()
  const faulted = useQuery({
    ...trpc.computers.faultedTasks.queryOptions(),
    refetchInterval: 30_000,
    retry: false
  })
  const ids = useMemo(() => (faulted.data?.length ? new Set(faulted.data) : EMPTY), [faulted.data])
  return <FaultedTasksContext.Provider value={ids}>{children}</FaultedTasksContext.Provider>
}

/** Whether this task has an item that needs attention (outside a provider: never). */
export function useTaskNeedsAttention(taskId: string): boolean {
  return useContext(FaultedTasksContext).has(taskId)
}
