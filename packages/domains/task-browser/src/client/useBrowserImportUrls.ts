import { useMemo, useState } from 'react'
import { useBrowserImportTasks } from './BrowserTaskSource'
import type { TaskUrlEntry } from './BrowserPanel.types'

interface UseBrowserImportUrlsParams {
  taskId?: string
  projectId?: string
}

export function useBrowserImportUrls({ taskId, projectId }: UseBrowserImportUrlsParams) {
  const [importDropdownOpen, setImportDropdownOpen] = useState(false)

  // Fetch URLs from other tasks in the same project (or all tasks) when the
  // dropdown opens. Task data comes from task via the registered source.
  const enabled = importDropdownOpen && !!taskId
  const tasks = useBrowserImportTasks({ projectId, enabled })

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
