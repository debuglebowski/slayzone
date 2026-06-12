import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'

export function registerProcessesLogsRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/processes/:id/logs', (req, res) => {
    if (!deps.processes) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    const proc = deps.processes.listAll().find((p) => p.id === req.params.id)
    if (!proc) {
      res.status(404).json({ error: `Process not found` })
      return
    }
    res.json({ id: proc.id, label: proc.label, logs: proc.logBuffer })
  })
}
