import type { Express } from 'express'
import type { RestApiDeps } from '../types'

export function registerCloseTaskRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/close-task/:id', (req, res) => {
    const taskId = req.params.id
    deps.menu?.emit('close-task', taskId)
    deps.legacyBroadcast?.('app:close-task', taskId) // slice 5: drop legacy send
    res.json({ ok: true })
  })
}
