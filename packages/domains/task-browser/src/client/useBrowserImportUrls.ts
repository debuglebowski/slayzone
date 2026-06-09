import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { TaskUrlEntry } from './BrowserPanel.types'

interface UseBrowserImportUrlsParams {
  taskId?: string
  projectId?: string
}

export function useBrowserImportUrls({ taskId, projectId }: UseBrowserImportUrlsParams) {
  const trpc = useTRPC()
  const [importDropdownOpen, setImportDropdownOpen] = useState(false)

  // Fetch URLs from other tasks in the same project (or all tasks) when the
  // dropdown opens. Two mutually-exclusive queries keyed on projectId presence.
  const enabled = importDropdownOpen && !!taskId
  const byProjectQuery = useQuery(
    trpc.task.getByProject.queryOptions(
      { projectId: projectId ?? '' },
      { enabled: enabled && !!projectId }
    )
  )
  const allQuery = useQuery(
    trpc.task.getAll.queryOptions(undefined, { enabled: enabled && !projectId })
  )

  const tasks = projectId ? byProjectQuery.data : allQuery.data

  const otherTaskUrls = useMemo<TaskUrlEntry[]>(() => {
    if (!enabled || !tasks) return []
    const entries: TaskUrlEntry[] = []
    for (const t of tasks) {
      if (t.id === taskId) continue
      if (!t.browser_tabs?.tabs) continue
      for (const tab of t.browser_tabs.tabs) {
        if (tab.url && tab.url !== 'about:blank') {
          entries.push({ taskId: t.id, taskTitle: t.title, url: tab.url, tabTitle: tab.title })
        }
      }
    }
    return entries
  }, [enabled, tasks, taskId])

  return { otherTaskUrls, importDropdownOpen, setImportDropdownOpen }
}
