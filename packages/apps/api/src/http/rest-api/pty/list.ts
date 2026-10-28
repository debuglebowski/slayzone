import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'

export function registerPtyListRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/pty', async (_req, res) => {
    if (!deps.pty) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    res.json(await deps.pty.listPtys())
  })
}
