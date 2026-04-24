import type { Express } from 'express'
import { listAllProcesses } from '../../process-manager'
import type { RestApiDeps } from '../types'

export function registerProcessesListRoute(app: Express, _deps: RestApiDeps): void {
  app.get('/api/processes', (_req, res) => {
    const procs = listAllProcesses().map(({ logBuffer: _, ...p }) => p)
    res.json(procs)
  })
}
