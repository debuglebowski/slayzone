import type { Express } from 'express'
import type { RestApiDeps } from './types'

export function registerNotifyRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/notify', (_req, res) => {
    deps.notifyRenderer()
    res.json({ ok: true })
  })
}
