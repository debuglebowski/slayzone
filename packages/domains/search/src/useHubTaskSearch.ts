import { useEffect, useState } from 'react'
import { skipToken, useQuery } from '@tanstack/react-query'
import { hubHasFeature } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task-contracts'
import { useTRPC, useTRPCClient } from './client/trpc'

/** Typing pause before the hub is asked. */
export const HUB_TASK_SEARCH_DEBOUNCE_MS = 200
/** Shorter queries stay with the board search (too broad for the hub's). */
export const HUB_TASK_SEARCH_MIN_CHARS = 2

/**
 * The hub's task search (`task.search`) for the palette's query, once typing pauses:
 * titles and descriptions, archived tasks included. Undefined while off, waiting or on
 * a hub without the `task-search` feature — the palette then shows the board search
 * alone, as before.
 */
export function useHubTaskSearch(query: string, enabled: boolean): readonly Task[] | undefined {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const trimmed = query.trim()
  const [settled, setSettled] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setSettled(trimmed), HUB_TASK_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [trimmed])
  const { data: supported } = useQuery({
    queryKey: ['hub-feature', 'task-search'],
    queryFn: () =>
      hubHasFeature(client as unknown as Parameters<typeof hubHasFeature>[0], 'task-search'),
    staleTime: Infinity,
    enabled
  })
  const ask = enabled && supported === true && settled.length >= HUB_TASK_SEARCH_MIN_CHARS
  const { data } = useQuery({
    ...trpc.task.search.queryOptions(ask ? { query: settled, limit: 25 } : skipToken),
    staleTime: 30_000
  })
  return ask && settled === trimmed ? (data?.tasks as Task[] | undefined) : undefined
}
