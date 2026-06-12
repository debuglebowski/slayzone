import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'

export function registerProcessesDeleteRoute(app: Express, deps: RestApiDeps): void {
  app.delete('/api/processes/:id', async (req, res) => {
    if (!deps.processes) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    const ok = await deps.processes.kill(req.params.id)
    if (!ok) {
      res.status(404).json({ error: `Process not found` })
      return
    }
    res.json({ ok: true })
  })
}
