import type { Express } from 'express'
import { updateTabRow } from '@slayzone/task-terminals/server'
import { tabsEvents } from '@slayzone/task-terminals/server'
import { broadcastToWindows } from '../../broadcast-to-windows'
import type { RestApiDeps } from '../types'

export function registerTabsRenameRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/tabs/rename', async (req, res) => {
    const body = req.body as { id?: unknown; label?: unknown }
    const id = body?.id
    if (typeof id !== 'string' || !id) {
      res.status(400).json({ error: 'id required' })
      return
    }
    if (body.label !== null && typeof body.label !== 'string') {
      res.status(400).json({ error: 'label must be string or null' })
      return
    }
    // Empty string clears.
    const label = body.label === '' ? null : (body.label as string | null)

    const tab = await updateTabRow(deps.db, { id, label })
    if (!tab) {
      res.status(404).json({ error: `Tab not found: ${id}` })
      return
    }

    // Dual-emit: legacy IPC broadcast + tRPC tabsEvents (subscribers in slice 5).
    broadcastToWindows('tabs:changed', { taskId: tab.taskId })
    tabsEvents.emit('tabs:changed', { taskId: tab.taskId })

    res.json({ tab })
  })
}
