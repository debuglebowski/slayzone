import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'

export function registerPtyBufferRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/pty/:id/buffer', async (req, res) => {
    if (!deps.pty) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    let buffer: string | null
    try {
      buffer = await deps.pty.getBuffer(req.params.id)
    } catch (err) {
      // The session's computer holds the scrollback and could not be asked.
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) })
      return
    }
    if (buffer === null) {
      res.status(404).json({ error: 'PTY session not found' })
      return
    }
    res.setHeader('Content-Type', 'text/plain')
    res.end(buffer)
  })
}
