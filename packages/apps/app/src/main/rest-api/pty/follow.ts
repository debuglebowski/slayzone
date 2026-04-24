import type { Express } from 'express'
import { hasPty, subscribeToPtyData, onSessionChange, getBuffer } from '@slayzone/terminal/main'
import type { RestApiDeps } from '../types'

export function registerPtyFollowRoute(app: Express, _deps: RestApiDeps): void {
  app.get('/api/pty/:id/follow', (req, res) => {
    const id = req.params.id
    if (!hasPty(id)) { res.status(404).json({ error: 'PTY session not found' }); return }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.flushHeaders()

    // Subscribe first (sync) — no data can arrive until next tick
    const unsubData = subscribeToPtyData(id, (chunk) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    })

    // Replay existing buffer if requested (sync, same tick — no race)
    if (req.query.full === 'true') {
      const buffer = getBuffer(id)
      if (buffer) res.write(`data: ${JSON.stringify(buffer)}\n\n`)
    }

    // Detect session death
    const unsubSession = onSessionChange(() => {
      if (!hasPty(id) && !res.writableEnded) {
        res.write(`event: exit\ndata: {}\n\n`)
        res.end()
      }
    })

    req.on('close', () => {
      unsubData()
      unsubSession()
    })
  })
}
