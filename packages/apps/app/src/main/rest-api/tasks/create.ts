import type { Express } from 'express'
import { ipcMain } from 'electron'
import { CreateTaskInputSchema } from '@slayzone/task/shared'
import { createTaskOp } from '@slayzone/task/main'
import type { RestApiDeps } from '../types'

export function registerCreateTaskRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/tasks', async (req, res) => {
    const parsed = CreateTaskInputSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message })
      return
    }
    try {
      const task = await createTaskOp(deps.db, parsed.data, {
        ipcMain,
        onMutation: deps.notifyRenderer,
      })
      if (!task) {
        res.status(404).json({ ok: false, error: 'Task not created' })
        return
      }
      res.json({ ok: true, data: task })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
