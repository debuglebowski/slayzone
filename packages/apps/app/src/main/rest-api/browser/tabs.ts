import type { Express } from 'express'
import { listBrowserTabs } from '../../browser-registry'
import type { RestApiDeps } from '../types'

interface BrowserTabRow {
  id: string
  url?: string
  title?: string
}

interface BrowserTabsState {
  tabs: BrowserTabRow[]
  activeTabId: string | null
}

export function registerBrowserTabsRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/browser/tabs', (req, res) => {
    const taskId = req.query.taskId as string | undefined
    if (!taskId) { res.status(400).json({ error: 'taskId required' }); return }

    const row = deps.db
      .prepare('SELECT browser_tabs FROM tasks WHERE id = ?')
      .get(taskId) as { browser_tabs: string | null } | undefined

    if (!row) { res.status(404).json({ error: `Task ${taskId} not found` }); return }

    let parsed: BrowserTabsState | null = null
    if (row.browser_tabs) {
      try { parsed = JSON.parse(row.browser_tabs) as BrowserTabsState } catch { parsed = null }
    }

    const live = new Map<string, boolean>()
    let liveActive: string | null = null
    for (const t of listBrowserTabs(taskId)) {
      live.set(t.tabId, true)
      if (t.active) liveActive = t.tabId
    }

    const dbTabs = parsed?.tabs ?? []
    const dbActive = parsed?.activeTabId ?? null

    const tabs = dbTabs.map((t, idx) => ({
      idx,
      id: t.id,
      title: t.title ?? '',
      url: t.url ?? '',
      active: (liveActive ?? dbActive) === t.id,
      registered: live.has(t.id),
    }))

    res.json({ tabs })
  })
}
