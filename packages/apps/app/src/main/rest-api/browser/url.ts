import type { Express } from 'express'
import { ensureBrowserWc } from './shared'
import type { RestApiDeps } from '../types'

export function registerBrowserUrlRoute(app: Express, _deps: RestApiDeps): void {
  app.get('/api/browser/url', async (req, res) => {
    const result = await ensureBrowserWc(req.query.taskId as string, (req.query.panel as 'visible' | 'hidden') ?? 'hidden', res)
    if (!result) return
    res.json({ url: result.wc.getURL() })
  })
}
