import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'
import { waitForPtyState } from './_wait'

export function registerPtyWaitRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/pty/:id/wait', (req, res) => {
    const pty = deps.pty
    if (!pty) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    const id = req.params.id
    if (!pty.hasLivePty(id)) {
      res.status(404).json({ error: 'PTY session not found' })
      return
    }

    const targetState = (req.query.state as string) || 'idle'
    const timeout = Math.min(
      Math.max(parseInt(req.query.timeout as string, 10) || 60000, 1000),
      300000
    )

    const abort = new AbortController()
    req.on('close', () => abort.abort())
    void waitForPtyState(pty, id, targetState, timeout, abort.signal).then((result) => {
      if (abort.signal.aborted) return
      if (result.outcome === 'reached') {
        res.json({ state: result.state, waited: result.waited })
      } else if (result.outcome === 'dead') {
        res.status(410).json({ error: 'PTY session died while waiting', state: 'dead' })
      } else {
        res.status(408).json({
          error: `Timeout waiting for "${targetState}" (current: "${result.state}")`,
          state: result.state
        })
      }
    })
  })
}
