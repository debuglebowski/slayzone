import type { Express } from 'express'
import { ensureBrowserWc, execJs } from './shared'
import type { RestApiDeps } from '../types'

export function registerBrowserEvalRoute(app: Express, _deps: RestApiDeps): void {
  app.post('/api/browser/eval', async (req, res) => {
    const { taskId, code, panel = 'hidden' } = req.body ?? {}
    if (!code) { res.status(400).json({ error: 'code required' }); return }
    const bwc = await ensureBrowserWc(taskId, panel, res)
    if (!bwc) return
    try {
      const result = await execJs(bwc.wc, code)
      res.json({ ok: true, result })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
