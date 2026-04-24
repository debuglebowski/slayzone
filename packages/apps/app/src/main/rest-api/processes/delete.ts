import type { Express } from 'express'
import { killProcess } from '../../process-manager'
import type { RestApiDeps } from '../types'

export function registerProcessesDeleteRoute(app: Express, _deps: RestApiDeps): void {
  app.delete('/api/processes/:id', (req, res) => {
    const ok = killProcess(req.params.id)
    if (!ok) { res.status(404).json({ error: `Process not found` }); return }
    res.json({ ok: true })
  })
}
