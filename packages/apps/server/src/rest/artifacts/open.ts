import type { Express } from 'express'
import type { RestApiDeps } from '../types'

export function registerOpenArtifactRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/open-artifact/:id', (req, res) => {
    const artifactId = req.params.id
    const row = deps.db.prepare('SELECT task_id FROM task_artifacts WHERE id = ?').get(artifactId) as { task_id: string } | undefined
    if (!row) { res.status(404).json({ error: 'Artifact not found' }); return }
    const taskId = row.task_id
    deps.notifyRenderer()
    deps.menuEvents?.emit('open-artifact', { taskId, artifactId })
    res.json({ ok: true })
  })
}
