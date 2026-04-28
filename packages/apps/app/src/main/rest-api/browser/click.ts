import type { Express } from 'express'
import { ensureBrowserWc, execJs } from './shared'
import type { RestApiDeps } from '../types'

export function registerBrowserClickRoute(app: Express, _deps: RestApiDeps): void {
  app.post('/api/browser/click', async (req, res) => {
    const { taskId, selector, panel = 'hidden', tabId } = req.body ?? {}
    if (!selector) { res.status(400).json({ error: 'selector required' }); return }
    const bwc = await ensureBrowserWc(taskId, panel, res, undefined, tabId)
    if (!bwc) return
    try {
      const result = await execJs<{ ok: boolean; error?: string; tag?: string; text?: string }>(bwc.wc, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { ok: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 100) };
      })()`)
      if (!result.ok) { res.status(404).json(result); return }
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
