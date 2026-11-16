import type { Express } from 'express'
import { ensureBrowserTab } from './shared'
import type { RestApiDeps } from '../types'

/**
 * Capture the targeted tab and hand the PNG BYTES (base64) to the requester. The
 * hub writes nothing: the requester (a CLI) may run on another machine, so it writes
 * the file where it runs.
 */
export function registerBrowserScreenshotRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/browser/screenshot', async (req, res) => {
    const { taskId, panel = 'hidden', tabId } = req.body ?? {}
    const bwc = await ensureBrowserTab(deps, taskId, panel, res, undefined, tabId)
    if (!bwc) return
    try {
      const png = await deps.browser!.capturePng(taskId, bwc.tabId)
      if (!png || png.length === 0) {
        res.status(500).json({ error: 'Captured image is empty' })
        return
      }
      res.json({ ok: true, pngBase64: Buffer.from(png).toString('base64') })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
