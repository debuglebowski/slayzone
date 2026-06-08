import type { Express } from 'express'
import { splitTabRow } from '@slayzone/task-terminals/server'
import { tabsEvents } from '@slayzone/task-terminals/server'
import { broadcastToWindows } from '../../broadcast-to-windows'
import { menuEvents } from '../../menu-events'
import type { RestApiDeps } from '../types'

export function registerTabsSplitRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/tabs/split', async (req, res) => {
    const body = req.body as { tabId?: unknown }
    const tabId = body?.tabId
    if (typeof tabId !== 'string' || !tabId) {
      res.status(400).json({ error: 'tabId required' })
      return
    }
    const tab = await splitTabRow(deps.db, tabId)
    if (!tab) {
      res.status(404).json({ error: `Tab not found: ${tabId}` })
      return
    }

    menuEvents.emit('open-task', { taskId: tab.taskId })
    broadcastToWindows('app:open-task', tab.taskId) // slice 5: drop legacy send
    // Dual-emit: legacy IPC broadcast + tRPC tabsEvents (subscribers in slice 5).
    broadcastToWindows('tabs:changed', { taskId: tab.taskId, focusTabId: tab.id })
    tabsEvents.emit('tabs:changed', { taskId: tab.taskId, focusTabId: tab.id })

    res.json({ tab, sessionId: `${tab.taskId}:${tab.id}` })
  })
}
