import type { Express } from 'express'
import { ipcMain } from 'electron'
import { updateTaskInputSchema, type UpdateTaskInput } from '@slayzone/task/shared'
import { updateTaskOp } from '@slayzone/task/main'
import type { RestApiDeps } from '../types'

export function registerUpdateTaskRoute(app: Express, deps: RestApiDeps): void {
  app.patch('/api/tasks/:id', async (req, res) => {
    const parsed = updateTaskInputSchema.safeParse({ ...(req.body ?? {}), id: req.params.id })
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message })
      return
    }
    try {
      const task = await updateTaskOp(deps.db, parsed.data as UpdateTaskInput, { ipcMain, onMutation: deps.notifyRenderer })
      if (!task) {
        res.status(404).json({ ok: false, error: 'Task not found' })
        return
      }
      res.json({ ok: true, data: task })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
