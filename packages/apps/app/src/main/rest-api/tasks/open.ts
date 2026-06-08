import type { Express } from 'express'
import { BrowserWindow } from 'electron'
import { broadcastToWindows } from '../../broadcast-to-windows'
import { menuEvents } from '../../menu-events'
import type { RestApiDeps } from '../types'

export function registerOpenTaskRoute(app: Express, _deps: RestApiDeps): void {
  app.post('/api/open-task/:id', (req, res) => {
    const taskId = req.params.id
    const background = req.query.background === '1' || req.query.background === 'true'
    menuEvents.emit('open-task', { taskId, background })
    broadcastToWindows('app:open-task', taskId, background) // slice 5: drop legacy send
    if (!background) {
      const mainWin = BrowserWindow.getAllWindows()[0]
      if (mainWin) {
        if (mainWin.isMinimized()) mainWin.restore()
        mainWin.show()
        mainWin.focus()
      }
    }
    res.json({ ok: true })
  })
}
