import type { Express } from 'express'
import { createTabRow } from '@slayzone/task-terminals/server'
import { tabsEvents } from '@slayzone/task-terminals/server'
import type { TerminalMode } from '@slayzone/terminal/shared'
import { broadcastToWindows } from '../../broadcast-to-windows'
import { menuEvents } from '../../menu-events'
import type { RestApiDeps } from '../types'

export function registerTabsCreateRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/tabs/create', async (req, res) => {
    const body = req.body as { taskId?: unknown; mode?: unknown; label?: unknown }
    const taskId = body?.taskId
    if (typeof taskId !== 'string' || !taskId) {
      res.status(400).json({ error: 'taskId required' })
      return
    }
    const row = await deps.db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)
    if (!row) {
      res.status(404).json({ error: `Task not found: ${taskId}` })
      return
    }
    const mode = typeof body.mode === 'string' ? (body.mode as TerminalMode) : undefined
    const label = typeof body.label === 'string' ? body.label : undefined
    const tab = await createTabRow(deps.db, { taskId, mode, label })

    // Open the task tab so its TaskDetailPage mounts (PTY only spawns when
    // TerminalView mounts in the renderer). Also fires for already-open tasks
    // — broadcast is idempotent.
    menuEvents.emit('open-task', { taskId })
    broadcastToWindows('app:open-task', taskId) // slice 5: drop legacy send
    // Trigger renderer re-fetch + auto-focus the new group. Dual-emit: legacy
    // IPC broadcast + tRPC tabsEvents (renderer subscribers land in slice 5).
    broadcastToWindows('tabs:changed', { taskId, focusTabId: tab.id })
    tabsEvents.emit('tabs:changed', { taskId, focusTabId: tab.id })

    res.json({ tab, sessionId: `${taskId}:${tab.id}` })
  })
}
