import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'

/**
 * Terminal sessions a computer still runs from a previous hub run that could not be
 * adopted into their tabs (terminal unattached-sessions): `slay pty unattached`,
 * `slay pty attach`, `slay pty kill`. Addressed by computer + session: a session
 * that maps to no task has no other owner.
 */
export function registerPtyUnattachedRoutes(app: Express, deps: RestApiDeps): void {
  app.get('/api/pty/unattached', async (_req, res) => {
    if (!deps.pty) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    res.json(await deps.pty.listUnattached())
  })

  app.post('/api/pty/unattached/:computerId/:sessionId/attach', async (req, res) => {
    if (!deps.pty) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    const result = await deps.pty.attachUnattached(req.params.computerId, req.params.sessionId)
    if (result.ok) {
      res.json({ ok: true })
      return
    }
    if (result.reason === 'not-found') {
      res.status(404).json({ error: 'No unattached session with that id', reason: result.reason })
      return
    }
    res.status(409).json({
      error: `Not attached (${result.reason})${result.detail ? `: ${result.detail}` : ''}`,
      reason: result.reason
    })
  })

  app.delete('/api/pty/unattached/:computerId/:sessionId', async (req, res) => {
    if (!deps.pty) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    const result = await deps.pty.killUnattached(req.params.computerId, req.params.sessionId)
    if (!result.ok) {
      res.status(404).json({ error: 'No unattached session with that id', reason: result.reason })
      return
    }
    res.json({ ok: true })
  })
}
