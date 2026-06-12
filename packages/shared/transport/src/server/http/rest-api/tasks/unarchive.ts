import type { Express } from 'express'
import { ZodError } from 'zod'
import { unarchiveInputSchema } from '@slayzone/task/shared'
import { unarchiveTaskOp } from '@slayzone/task/server'
import type { RestApiDeps } from '../types'
import { NOOP_TASK_BUS } from '../types'

export function registerUnarchiveTaskRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/tasks/:id/unarchive', (req, res) => {
    try {
      const input = unarchiveInputSchema.parse({ id: req.params.id })
      const task = unarchiveTaskOp(deps.db, input.id, {
        ipcMain: deps.taskBus ?? NOOP_TASK_BUS,
        onMutation: deps.notifyRenderer
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
