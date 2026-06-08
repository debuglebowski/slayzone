import type { Express } from 'express'
import { broadcastToWindows } from '../../broadcast-to-windows'
import { menuEvents } from '../../menu-events'
import type { RestApiDeps } from '../types'

export function registerOpenArtifactRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/open-artifact/:id', async (req, res) => {
    const artifactId = req.params.id
    const row = (await deps.db
      .prepare('SELECT task_id FROM task_artifacts WHERE id = ?')
      .get(artifactId)) as { task_id: string } | undefined
    if (!row) {
      res.status(404).json({ error: 'Artifact not found' })
      return
    }
    const taskId = row.task_id
    deps.notifyRenderer()
    menuEvents.emit('open-artifact', { taskId, artifactId })
    broadcastToWindows('app:open-artifact', { taskId, artifactId }) // slice 5: drop legacy send
    res.json({ ok: true })
  })
}
