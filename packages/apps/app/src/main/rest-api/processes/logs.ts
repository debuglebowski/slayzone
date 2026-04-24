import type { Express } from 'express'
import { listAllProcesses } from '../../process-manager'
import type { RestApiDeps } from '../types'

export function registerProcessesLogsRoute(app: Express, _deps: RestApiDeps): void {
  app.get('/api/processes/:id/logs', (req, res) => {
    const proc = listAllProcesses().find(p => p.id === req.params.id)
    if (!proc) { res.status(404).json({ error: `Process not found` }); return }
    res.json({ id: proc.id, label: proc.label, logs: proc.logBuffer })
  })
}
