import type { Express } from 'express'
import { ensureBrowserTab } from './shared'
import type { RestApiDeps } from '../types'

export function registerBrowserUrlRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/browser/url', async (req, res) => {
    const result = await ensureBrowserTab(
      deps,
      req.query.taskId as string,
      (req.query.panel as 'visible' | 'hidden') ?? 'hidden',
      res,
      undefined,
      req.query.tabId as string | undefined
    )
    if (!result) return
    res.json({ url: await deps.browser!.getUrl(req.query.taskId as string, result.tabId) })
  })
}
