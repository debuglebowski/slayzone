import type { Express } from 'express'
import type { RestApiDeps } from '../types'

export function registerAutomationsRunRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/automations/:id/run', async (req, res) => {
    if (!deps.automationEngine) {
      res.status(501).json({ error: 'Automation engine not available' })
      return
    }
    try {
      const run = await deps.automationEngine.executeManual(req.params.id)
      res.json(run)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
