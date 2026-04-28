import type { Express } from 'express'
import { broadcastToWindows } from '../../broadcast-to-windows'
import type { RestApiDeps } from '../types'

export function registerOpenAssetRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/open-asset/:id', (req, res) => {
    const assetId = req.params.id
    const row = deps.db.prepare('SELECT task_id FROM task_assets WHERE id = ?').get(assetId) as { task_id: string } | undefined
    if (!row) { res.status(404).json({ error: 'Asset not found' }); return }
    const taskId = row.task_id
    deps.notifyRenderer()
    broadcastToWindows('app:open-asset', { taskId, assetId })
    res.json({ ok: true })
  })
}
