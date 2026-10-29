import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from './trpc'
import type { Tag } from '@slayzone/tags/shared'

export interface UseTaskTagIdsReturn {
  tagIds: string[]
  setTagIds: (ids: string[]) => void
}

/**
 * The task's tag ids, query-backed so external changes (CLI, MCP) reach it via
 * the app's single `tasks-changed` refresh (`refreshTaskScopedQueries`) rather
 * than a subscription per open tab.
 *
 * `staleTime: Infinity`: the tab's loader already fetched these tags
 * (`initialTags`), so mounting does not refetch — only an invalidation does,
 * as before when only a `tasks-changed` event triggered a fetch.
 */
export function useTaskTagIds(
  taskId: string | null | undefined,
  initialTagIds?: string[],
  initialTags?: Tag[]
): UseTaskTagIdsReturn {
  const trpc = useTRPC()
  // Destructure `data`: the query result object is a fresh wrapper on every render,
  // so anything derived from it (tagIds, setTagIds) would be too — and those flow
  // into TaskDetailPage's settings-panel closure, re-rendering that panel in every
  // hidden tab a switch touches. `data` keeps its identity until the tags change.
  const { data } = useQuery(
    trpc.tags.getForTask.queryOptions(
      { taskId: taskId ?? '' },
      { enabled: !!taskId, staleTime: Infinity, initialData: taskId ? initialTags : undefined }
    )
  )
  // A local edit (TagsCard writes the new set, then reports it) shows at once and
  // holds until the query answers again — the next answer is server truth.
  const [local, setLocal] = useState<{ ids: string[]; over: Tag[] | undefined } | null>(null)
  const tagIds =
    local && local.over === data ? local.ids : data ? data.map((t) => t.id) : (initialTagIds ?? [])

  const setTagIds = (ids: string[]): void => setLocal({ ids, over: data })

  return { tagIds, setTagIds }
}
