import type { Express } from 'express'
import { isTrustedLocal, requireBrowser } from './shared'
import type { RestApiDeps } from '../types'

interface BrowserTabRow {
  id: string
  url?: string
  title?: string
  isolated?: boolean
}

interface BrowserTabsState {
  tabs: BrowserTabRow[]
  activeTabId: string | null
}

export function registerBrowserTabsRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/browser/tabs', async (req, res) => {
    const browser = requireBrowser(deps, res)
    if (!browser) return
    const taskId = req.query.taskId as string | undefined
    if (!taskId) {
      res.status(400).json({ error: 'taskId required' })
      return
    }

    const row = (await deps.db
      .prepare('SELECT browser_tabs FROM tasks WHERE id = ?')
      .get(taskId)) as { browser_tabs: string | null } | undefined

    if (!row) {
      res.status(404).json({ error: `Task ${taskId} not found` })
      return
    }

    let parsed: BrowserTabsState | null = null
    if (row.browser_tabs) {
      try {
        parsed = JSON.parse(row.browser_tabs) as BrowserTabsState
      } catch {
        parsed = null
      }
    }

    const caller = browser.callerOf(req)
    const live = new Map<string, { isolated: boolean }>()
    let liveActive: string | null = null
    for (const t of await browser.listBrowserTabs(caller, taskId)) {
      live.set(t.tabId, { isolated: !!t.isolated })
      if (t.active) liveActive = t.tabId
    }
    // On the desktop's own hub only its local agent sees the user's own tabs; anyone
    // else, the isolated ones. (A remote hub's tabs are all isolated from the user's
    // own browser: their own partition.)
    const isolatedOf = (t: BrowserTabRow): boolean =>
      !browser.isDesktopLocalHub || !!t.isolated || !!live.get(t.id)?.isolated
    const visible = isTrustedLocal(browser, caller) ? () => true : isolatedOf

    const dbTabs = (parsed?.tabs ?? []).filter(visible)
    const dbActive = parsed?.activeTabId ?? null

    const tabs = dbTabs.map((t, idx) => ({
      idx,
      id: t.id,
      title: t.title ?? '',
      url: t.url ?? '',
      active: (liveActive ?? dbActive) === t.id,
      registered: live.has(t.id),
      isolated: isolatedOf(t)
    }))

    res.json({ tabs })
  })
}
