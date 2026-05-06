import type { Express } from 'express'
import { splitTabRow } from '@slayzone/task-terminals/server'
import { broadcastToWindows } from '../../broadcast-to-windows'
import type { RestApiDeps } from '../types'

export function registerTabsSplitRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/tabs/split', (req, res) => {
    const body = req.body as { tabId?: unknown }
    const tabId = body?.tabId
    if (typeof tabId !== 'string' || !tabId) {
      res.status(400).json({ error: 'tabId required' })
      return
    }
    const tab = splitTabRow(deps.db, tabId)
    if (!tab) {
      res.status(404).json({ error: `Tab not found: ${tabId}` })
      return
    }

    broadcastToWindows('app:open-task', tab.taskId)
    broadcastToWindows('tabs:changed', { taskId: tab.taskId, focusTabId: tab.id })

    res.json({ tab, sessionId: `${tab.taskId}:${tab.id}` })
  })
}
