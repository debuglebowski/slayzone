import type { Express } from 'express'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs'
import { ensureBrowserTab } from './shared'
import type { RestApiDeps } from '../types'

export function registerBrowserScreenshotRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/browser/screenshot', async (req, res) => {
    const { taskId, panel = 'hidden', tabId } = req.body ?? {}
    const bwc = await ensureBrowserTab(deps, taskId, panel, res, undefined, tabId)
    if (!bwc) return
    try {
      // The tmpdir choice + retention sweep stay here (pure fs, and the host is
      // the same machine when supervised); only the capture itself is bridged, and
      // it writes the PNG straight to disk so the image never crosses as a buffer.
      // os.tmpdir() == Electron's app.getPath('temp') on every platform we ship.
      const dir = join(tmpdir(), 'slayzone', 'browser-screenshots')
      mkdirSync(dir, { recursive: true })
      // Clean up screenshots older than 1 hour
      try {
        const cutoff = Date.now() - 3600_000
        for (const f of readdirSync(dir)) {
          const fp = join(dir, f)
          try {
            if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp)
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore cleanup errors */
      }
      const filePath = join(dir, `${randomUUID()}.png`)
      const captured = await deps.browser!.capturePageToFile(taskId, bwc.tabId, filePath)
      if (!captured) {
        res.status(500).json({ error: 'Captured image is empty' })
        return
      }
      res.json({ ok: true, path: filePath })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
