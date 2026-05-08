import type { Express } from 'express'
import { listPtys } from '@slayzone/terminal/electron'
import type { RestApiDeps } from '@slayzone/server'

export function registerPtyListRoute(app: Express, _deps: RestApiDeps): void {
  app.get('/api/pty', (_req, res) => {
    res.json(listPtys())
  })
}
