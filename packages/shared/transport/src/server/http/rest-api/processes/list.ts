import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'

export function registerProcessesListRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/processes', (_req, res) => {
    if (!deps.processes) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    const procs = deps.processes.listAll().map(({ logBuffer: _, ...p }) => p)
    res.json(procs)
  })
}
