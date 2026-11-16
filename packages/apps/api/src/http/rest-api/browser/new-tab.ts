import type { Express } from 'express'
import {
  ALLOWED_NAVIGATE_SCHEMES,
  NO_DESKTOP,
  isTrustedLocal,
  refuseTarget,
  requireBrowser
} from './shared'
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

function generateTabId(): string {
  const rnd =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `tab-${rnd.slice(0, 8)}`
}

export function registerBrowserNewTabRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/browser/tabs', async (req, res) => {
    const browser = requireBrowser(deps, res)
    if (!browser) return
    const { taskId, url, panel = 'visible', background = false } = req.body ?? {}
    if (!taskId) {
      res.status(400).json({ error: 'taskId required' })
      return
    }

    if (url) {
      try {
        const parsed = new URL(url)
        if (!ALLOWED_NAVIGATE_SCHEMES.includes(parsed.protocol)) {
          res.status(400).json({ error: `Scheme not allowed: ${parsed.protocol}` })
          return
        }
      } catch {
        res.status(400).json({ error: 'Invalid URL' })
        return
      }
      if (refuseTarget(browser, req, url, res)) return
    }

    if (panel !== 'visible' && panel !== 'hidden') {
      res.status(400).json({ error: `panel must be 'visible' or 'hidden'` })
      return
    }

    const exists = await deps.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId)
    if (!exists) {
      res.status(404).json({ error: `Task ${taskId} not found` })
      return
    }

    const caller = browser.callerOf(req)
    if (!browser.hasCapableClient(caller)) {
      res.status(503).json({ error: NO_DESKTOP })
      return
    }

    const tabId = generateTabId()

    if (panel === 'visible') {
      // Open panel first (no-op if already open), then dispatch tab creation.
      deps.menu?.emit('browser-ensure-panel-open', {
        taskId,
        origin: caller.origin,
        principal: caller.principal
      })
      deps.legacyBroadcast?.('browser:ensure-panel-open', taskId) // slice 5: drop legacy send
    }

    // Only the trusted local agent's URL opens with the tab; anyone else's tab opens
    // blank and the URL loads through the relay (name resolved first; refusal reported).
    // Anyone but the desktop's own local agent gets an ISOLATED tab: its own empty
    // browser, never the user's logins, files or local network.
    const trusted = isTrustedLocal(browser, caller)
    const openWith = url && trusted ? url : undefined
    deps.menu?.emit('browser-create-tab', {
      taskId,
      tabId,
      url: openWith,
      background,
      origin: caller.origin,
      principal: caller.principal,
      isolated: !trusted
    })
    deps.legacyBroadcast?.('browser:create-tab', { taskId, tabId, url: openWith, background }) // slice 5: drop legacy send

    try {
      await browser.waitForBrowserRegistration(caller, taskId, { tabId, timeoutMs: 10_000 })
    } catch (err) {
      res.status(408).json({ error: err instanceof Error ? err.message : String(err) })
      return
    }

    if (url && !openWith) {
      try {
        await browser.loadUrl(caller, taskId, tabId, url)
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err), tabId })
        return
      }
    }

    const row = (await deps.db
      .prepare('SELECT browser_tabs FROM tasks WHERE id = ?')
      .get(taskId)) as { browser_tabs: string | null } | undefined
    let idx = -1
    if (row?.browser_tabs) {
      try {
        const parsed = JSON.parse(row.browser_tabs) as BrowserTabsState
        idx = parsed.tabs.findIndex((t) => t.id === tabId)
      } catch {
        /* ignore */
      }
    }

    res.json({ ok: true, tabId, idx, url: url ?? null })
  })
}
