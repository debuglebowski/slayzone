import type { Express } from 'express'
import { broadcastToWindows } from '../../broadcast-to-windows'
import type { RestApiDeps } from '../types'

export function registerCloseTaskRoute(app: Express, _deps: RestApiDeps): void {
  app.post('/api/close-task/:id', (req, res) => {
    const taskId = req.params.id
    broadcastToWindows('app:close-task', taskId)
    res.json({ ok: true })
  })
}
