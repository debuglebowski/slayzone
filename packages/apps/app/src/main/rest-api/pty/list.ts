import type { Express } from 'express'
import { listPtys } from '@slayzone/terminal/main'
import type { RestApiDeps } from '../types'

export function registerPtyListRoute(app: Express, _deps: RestApiDeps): void {
  app.get('/api/pty', (_req, res) => {
    res.json(listPtys())
  })
}
