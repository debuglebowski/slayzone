import type { Express } from 'express'
import { broadcastToWindows } from '../../broadcast-to-windows'
import { menuEvents } from '../../menu-events'
import type { RestApiDeps } from '../types'

export function registerCloseTaskRoute(app: Express, _deps: RestApiDeps): void {
  app.post('/api/close-task/:id', (req, res) => {
    const taskId = req.params.id
    menuEvents.emit('close-task', taskId)
    broadcastToWindows('app:close-task', taskId) // slice 5: drop legacy send
    res.json({ ok: true })
  })
}
