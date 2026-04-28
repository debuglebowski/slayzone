import type { Express } from 'express'
import { ensureBrowserWc, ALLOWED_NAVIGATE_SCHEMES } from './shared'
import type { RestApiDeps } from '../types'

export function registerBrowserNavigateRoute(app: Express, _deps: RestApiDeps): void {
  app.post('/api/browser/navigate', async (req, res) => {
    const { taskId, url, panel = 'visible', tabId } = req.body ?? {}
    if (!url) { res.status(400).json({ error: 'url required' }); return }
    try {
      const parsed = new URL(url)
      if (!ALLOWED_NAVIGATE_SCHEMES.includes(parsed.protocol)) {
        res.status(400).json({ error: `Scheme not allowed: ${parsed.protocol}` }); return
      }
    } catch {
      res.status(400).json({ error: 'Invalid URL' }); return
    }
    const result = await ensureBrowserWc(taskId, panel, res, url, tabId)
    if (!result) return
    try {
      // Skip loadURL when panel was just auto-opened — the renderer already created a tab with this URL
      if (!result.autoOpened) await result.wc.loadURL(url)
      res.json({ ok: true, url: result.wc.getURL() })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
