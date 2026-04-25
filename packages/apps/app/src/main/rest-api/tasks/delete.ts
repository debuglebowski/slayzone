import { ipcMain } from 'electron'
import type { Express } from 'express'
import { ZodError } from 'zod'
import { deleteTaskInputSchema } from '@slayzone/task/shared'
import { deleteTaskOp } from '@slayzone/task/main'
import type { RestApiDeps } from '../types'

export function registerDeleteTaskRoute(app: Express, deps: RestApiDeps): void {
  app.delete('/api/tasks/:id', (req, res) => {
    try {
      const input = deleteTaskInputSchema.parse({ id: req.params.id })
      const result = deleteTaskOp(deps.db, input.id, {
        ipcMain,
        onMutation: deps.notifyRenderer,
      })
      if (result === false) {
        res.status(404).json({ ok: false, error: 'Task not found' })
        return
      }
      res.json({ ok: true, data: result })
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({ ok: false, error: err.message })
        return
      }
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
