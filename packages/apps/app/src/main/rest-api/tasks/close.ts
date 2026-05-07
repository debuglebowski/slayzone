import type { Express } from 'express'
import { menuEvents } from '../../menu-events'
import type { RestApiDeps } from '../types'

export function registerCloseTaskRoute(app: Express, _deps: RestApiDeps): void {
  app.post('/api/close-task/:id', (req, res) => {
    const taskId = req.params.id
    menuEvents.emit('close-task', taskId)
    res.json({ ok: true })
  })
}
