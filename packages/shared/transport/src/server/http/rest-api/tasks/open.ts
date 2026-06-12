import type { Express } from 'express'
import type { RestApiDeps } from '../types'

export function registerOpenTaskRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/open-task/:id', (req, res) => {
    const taskId = req.params.id
    const background = req.query.background === '1' || req.query.background === 'true'
    deps.menu?.emit('open-task', { taskId, background })
    deps.legacyBroadcast?.('app:open-task', taskId, background) // slice 5: drop legacy send
    if (!background) {
      deps.windowActions?.raiseMainWindow()
    }
    res.json({ ok: true })
  })
}
