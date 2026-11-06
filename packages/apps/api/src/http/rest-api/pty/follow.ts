import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'

export function registerPtyFollowRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/pty/:id/follow', (req, res) => {
    const pty = deps.pty
    if (!pty) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    const id = req.params.id
    if (!pty.hasPty(id)) {
      res.status(404).json({ error: 'PTY session not found' })
      return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.flushHeaders()

    const send = (chunk: string): void => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
    // Subscribe FIRST, so nothing produced while the scrollback is read is lost.
    // With `full`, the scrollback can be a round trip (the session's computer owns
    // it): live chunks are held until it answers, then only those after the seq it
    // reached are written — gap-free, nothing twice.
    const full = req.query.full === 'true'
    let held: Array<[string, number]> | null = full ? [] : null
    const unsubData = pty.subscribeToPtyData(id, (chunk, seq) => {
      if (held) held.push([chunk, seq])
      else send(chunk)
    })
    if (full) {
      void pty
        .getBufferSince(id, -1)
        .catch(() => null)
        .then((replay) => {
          const after = replay?.currentSeq ?? -1
          const text = replay ? replay.prelude + replay.chunks.map((c) => c.data).join('') : ''
          if (text) send(text)
          const pending = held ?? []
          held = null
          for (const [chunk, seq] of pending) if (seq > after) send(chunk)
        })
    }

    // Detect session death
    const unsubSession = pty.onSessionChange(() => {
      if (!pty.hasPty(id) && !res.writableEnded) {
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
