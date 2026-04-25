import type { Express } from 'express'
import { ipcMain } from 'electron'
import { ZodError } from 'zod'
import { archiveManyTasksOp } from '@slayzone/task/main'
import { archiveManyInputSchema } from '@slayzone/task/shared'
import type { RestApiDeps } from '../types'

export function registerArchiveManyTaskRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/tasks/archive-many', async (req, res) => {
    let input
    try {
      input = archiveManyInputSchema.parse(req.body)
    } catch (err) {
      const msg = err instanceof ZodError ? err.issues.map((i) => i.message).join('; ') : err instanceof Error ? err.message : String(err)
      res.status(400).json({ ok: false, error: msg })
      return
    }
    try {
      await archiveManyTasksOp(deps.db, input.ids, {
        ipcMain,
        onMutation: deps.notifyRenderer,
      })
      res.json({ ok: true, data: null })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
