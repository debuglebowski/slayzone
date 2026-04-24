import type { Express } from 'express'
import { getBuffer } from '@slayzone/terminal/main'
import type { RestApiDeps } from '../types'

export function registerPtyBufferRoute(app: Express, _deps: RestApiDeps): void {
  app.get('/api/pty/:id/buffer', (req, res) => {
    const buffer = getBuffer(req.params.id)
    if (buffer === null) { res.status(404).json({ error: 'PTY session not found' }); return }
    res.setHeader('Content-Type', 'text/plain')
    res.end(buffer)
  })
}
