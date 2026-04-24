import type { Express } from 'express'
import { ensureBrowserWc, execJs } from './shared'
import type { RestApiDeps } from '../types'

export function registerBrowserContentRoute(app: Express, _deps: RestApiDeps): void {
  app.get('/api/browser/content', async (req, res) => {
    const bwc = await ensureBrowserWc(req.query.taskId as string, (req.query.panel as 'visible' | 'hidden') ?? 'hidden', res)
    if (!bwc) return
    try {
      const content = await execJs(bwc.wc, `(() => {
        const url = location.href;
        const title = document.title;
        const text = (document.body?.innerText || '').slice(0, 50000);
        const interactive = Array.from(document.querySelectorAll('input,textarea,select,button,a[href]'))
          .slice(0, 200)
          .map(el => {
            const o = { tag: el.tagName.toLowerCase() };
            if (el.id) o.id = el.id;
            if (el.name) o.name = el.name;
            if (el.type) o.type = el.type;
            if (el.placeholder) o.placeholder = el.placeholder;
            if (el.href) o.href = el.href;
            if (el.getAttribute('aria-label')) o.ariaLabel = el.getAttribute('aria-label');
            const t = (el.textContent || '').trim().slice(0, 80);
            if (t) o.text = t;
            return o;
          });
        return { url, title, text, interactive };
      })()`)
      res.json(content)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
