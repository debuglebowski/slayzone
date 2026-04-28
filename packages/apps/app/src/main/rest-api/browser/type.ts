import type { Express } from 'express'
import { ensureBrowserWc, execJs } from './shared'
import type { RestApiDeps } from '../types'

export function registerBrowserTypeRoute(app: Express, _deps: RestApiDeps): void {
  app.post('/api/browser/type', async (req, res) => {
    const { taskId, selector, text, panel = 'hidden', tabId } = req.body ?? {}
    if (!selector || text == null) { res.status(400).json({ error: 'selector and text required' }); return }
    const bwc = await ensureBrowserWc(taskId, panel, res, undefined, tabId)
    if (!bwc) return
    try {
      const result = await execJs<{ ok: boolean; error?: string }>(bwc.wc, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
        el.scrollIntoView({ block: 'center' });
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(text)});
        else el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      })()`)
      if (!result.ok) { res.status(404).json(result); return }
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
