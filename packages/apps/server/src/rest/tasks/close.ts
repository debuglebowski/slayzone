import type { Express } from 'express'
import type { RestApiDeps } from '../types'

export function registerCloseTaskRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/close-task/:id', (req, res) => {
    const taskId = req.params.id
    deps.menuEvents?.emit('close-task', taskId)
    res.json({ ok: true })
  })
}
