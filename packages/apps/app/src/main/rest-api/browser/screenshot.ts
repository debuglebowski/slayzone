import type { Express } from 'express'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'node:fs'
import { ensureBrowserWc } from './shared'
import type { RestApiDeps } from '@slayzone/server'

export function registerBrowserScreenshotRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/browser/screenshot', async (req, res) => {
    const { taskId, panel = 'hidden', tabId } = req.body ?? {}
    const bwc = await ensureBrowserWc(taskId, panel, res, undefined, tabId)
    if (!bwc) return
    try {
      const image = await bwc.wc.capturePage()
      if (image.isEmpty()) { res.status(500).json({ error: 'Captured image is empty' }); return }
      const dir = join(deps.tempDir ?? tmpdir(), 'slayzone', 'browser-screenshots')
      mkdirSync(dir, { recursive: true })
      // Clean up screenshots older than 1 hour
      try {
        const cutoff = Date.now() - 3600_000
        for (const f of readdirSync(dir)) {
          const fp = join(dir, f)
          try { if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp) } catch { /* ignore */ }
        }
      } catch { /* ignore cleanup errors */ }
      const filePath = join(dir, `${randomUUID()}.png`)
      writeFileSync(filePath, image.toPNG())
      res.json({ ok: true, path: filePath })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
