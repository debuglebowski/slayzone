import type { Express } from 'express'
import { submitPty, hasPty } from '@slayzone/terminal/electron'
import { startMainPty, extractMainTaskId } from './_start-main'
import type { RestApiDeps } from '../types'

const AUTO_START_TIMEOUT_MS = 5_000

export function registerPtySubmitRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/pty/:id/submit', async (req, res) => {
    const text = req.body?.text
    if (typeof text !== 'string') {
      res.status(400).json({ error: 'Body must include "text" string' })
      return
    }
    const id = req.params.id
    if (!hasPty(id)) {
      const taskId = extractMainTaskId(id)
      if (taskId) {
        const r = await startMainPty(deps, taskId, { timeoutMs: AUTO_START_TIMEOUT_MS })
        if (r === 'no-window') {
          res.status(503).json({ error: 'No window available' })
          return
        }
        if (r === 'timeout') {
          res.status(504).json({ error: 'PTY start timed out' })
          return
        }
        if (r === 'error') {
          res.status(500).json({ error: 'Renderer reported start failure' })
          return
        }
      }
    }
    const ok = submitPty(id, text)
    if (!ok) {
      res.status(404).json({ error: 'PTY session not found' })
      return
    }
    res.json({ ok: true })
  })
}
