import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'

export function registerPtyBufferRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/pty/:id/buffer', (req, res) => {
    if (!deps.pty) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    const buffer = deps.pty.getBuffer(req.params.id)
    if (buffer === null) {
      res.status(404).json({ error: 'PTY session not found' })
      return
    }
    res.setHeader('Content-Type', 'text/plain')
    res.end(buffer)
  })
}
