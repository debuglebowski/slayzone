import { useMutation, useQuery } from '@tanstack/react-query'
import { useTRPC } from '../trpc'
import type { BrowserTaskSource } from '@slayzone/task-browser'

/**
 * task's half of task-browser's BrowserTaskSource contract: task sits above
 * task-browser, so it supplies the `task.*` data/writes the browser panel needs.
 * Registered in lazyPanels.tsx when the panel module loads (before first render).
 */
function useImportTasks({ projectId, enabled }: { projectId?: string; enabled: boolean }) {
  const trpc = useTRPC()
  // Two mutually-exclusive queries keyed on projectId presence.
  const byProjectQuery = useQuery(
    trpc.task.getByProject.queryOptions(
      { projectId: projectId ?? '' },
      { enabled: enabled && !!projectId }
    )
  )
  const allQuery = useQuery(
    trpc.task.getAll.queryOptions(undefined, { enabled: enabled && !projectId })
  )
  return projectId ? byProjectQuery.data : allQuery.data
}

function useSetBrowserTabLocked() {
  const trpc = useTRPC()
  return useMutation(trpc.task.setBrowserTabLocked.mutationOptions()).mutate
}

export const browserTaskSource: BrowserTaskSource = { useImportTasks, useSetBrowserTabLocked }
