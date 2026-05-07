import type { Express } from 'express'
import type { RestApiDeps } from '../types'

export function registerOpenTaskRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/open-task/:id', (req, res) => {
    const taskId = req.params.id
    deps.menuEvents?.emit('open-task', taskId)
    deps.focusMainWindow?.()
    res.json({ ok: true })
  })
}
