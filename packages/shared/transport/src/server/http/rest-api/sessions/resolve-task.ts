import type { Express } from 'express'
import type { RestApiDeps } from '../types'

// Stub: session → bound task resolution for the slay CLI. Returns 501 until wired.
export function registerResolveSessionTaskRoute(app: Express, _deps: RestApiDeps): void {
  app.get('/api/sessions/:id/task', (_req, res) => {
    res.status(501).json({ error: 'not implemented' })
  })
}
