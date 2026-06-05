import { useEffect, useState } from 'react'
import type { TaskUrlEntry } from './BrowserPanel.types'

interface UseBrowserImportUrlsParams {
  taskId?: string
  projectId?: string
}

export function useBrowserImportUrls({ taskId, projectId }: UseBrowserImportUrlsParams) {
  const [otherTaskUrls, setOtherTaskUrls] = useState<TaskUrlEntry[]>([])
  const [importDropdownOpen, setImportDropdownOpen] = useState(false)

  // Fetch URLs from other tasks in the same project when dropdown opens
  useEffect(() => {
    if (!importDropdownOpen || !taskId) return
    const promise = projectId
      ? window.api.db.getTasksByProject(projectId)
      : window.api.db.getTasks()
    promise.then((tasks) => {
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
      setOtherTaskUrls(entries)
    })
  }, [importDropdownOpen, taskId, projectId])

  return { otherTaskUrls, importDropdownOpen, setImportDropdownOpen }
}
