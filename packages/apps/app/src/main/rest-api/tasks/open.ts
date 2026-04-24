import type { Express } from 'express'
import { BrowserWindow } from 'electron'
import { broadcastToWindows } from '../../broadcast-to-windows'
import type { RestApiDeps } from '../types'

export function registerOpenTaskRoute(app: Express, _deps: RestApiDeps): void {
  app.post('/api/open-task/:id', (req, res) => {
    const taskId = req.params.id
    broadcastToWindows('app:open-task', taskId)
    const mainWin = BrowserWindow.getAllWindows()[0]
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore()
      mainWin.show()
      mainWin.focus()
    }
    res.json({ ok: true })
  })
}
