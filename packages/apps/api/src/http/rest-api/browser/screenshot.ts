import type { Express } from 'express'
import { ensureBrowserTab } from './shared'
import type { RestApiDeps } from '../types'

/** What a CLI that writes the PNG itself sends as `accept`. */
export const SCREENSHOT_ACCEPT = 'png-bytes'

/**
 * Capture the targeted tab and hand the PNG BYTES (base64) to the requester. The
 * hub writes nothing: the requester (a CLI) may run on another machine, so it writes
 * the file where it runs.
 */
export function registerBrowserScreenshotRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/browser/screenshot', async (req, res) => {
    const { taskId, panel = 'hidden', tabId, accept } = req.body ?? {}
    // A CLI from before bytes-not-paths sends no `accept` and would print the missing
    // `path` as "undefined". Refuse it loudly; its error printer shows `error`, exit 1.
    if (accept !== SCREENSHOT_ACCEPT) {
      res.status(409).json({
        error:
          'This slay CLI is too old for this hub: screenshots now return image bytes. Upgrade the slay CLI.'
      })
      return
    }
    const bwc = await ensureBrowserTab(deps, taskId, panel, res, undefined, tabId)
    if (!bwc) return
    try {
      const png = await deps.browser!.capturePng(taskId, bwc.tabId, deps.browser!.originOf(req))
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
