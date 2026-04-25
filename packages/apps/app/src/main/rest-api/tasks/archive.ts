import { ipcMain } from 'electron'
import type { Express } from 'express'
import { ZodError } from 'zod'
import { ArchiveTaskInput } from '@slayzone/task/shared'
import { archiveTaskOp } from '@slayzone/task/main'
import type { RestApiDeps } from '../types'

export function registerArchiveTaskRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/tasks/:id/archive', async (req, res) => {
    try {
      const input = ArchiveTaskInput.parse({ id: req.params.id })
      const task = await archiveTaskOp(deps.db, input.id, {
        ipcMain,
        onMutation: deps.notifyRenderer,
      })
      if (!task) {
        res.status(404).json({ ok: false, error: 'Task not found' })
        return
      }
      res.json({ ok: true, data: task })
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({ ok: false, error: err.message })
        return
      }
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
