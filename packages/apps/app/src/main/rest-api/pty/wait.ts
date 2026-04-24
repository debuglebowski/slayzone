import type { Express } from 'express'
import { hasPty, onSessionChange, subscribeToStateChange, getState } from '@slayzone/terminal/main'
import type { RestApiDeps } from '../types'

export function registerPtyWaitRoute(app: Express, _deps: RestApiDeps): void {
  app.get('/api/pty/:id/wait', (req, res) => {
    const id = req.params.id
    if (!hasPty(id)) { res.status(404).json({ error: 'PTY session not found' }); return }

    const targetState = (req.query.state as string) || 'attention'
    const timeout = Math.min(Math.max(parseInt(req.query.timeout as string, 10) || 60000, 1000), 300000)

    // Fast path: already in target state
    const currentState = getState(id)
    if (currentState === targetState) {
      res.json({ state: currentState, waited: false })
      return
    }

    let resolved = false
    const cleanup = (): void => {
      resolved = true
      unsubState()
      unsubSession()
      clearTimeout(timer)
    }

    const unsubState = subscribeToStateChange(id, (newState) => {
      if (resolved) return
      if (newState === targetState) {
        cleanup()
        res.json({ state: newState, waited: true })
      }
    })

    const unsubSession = onSessionChange(() => {
      if (resolved) return
      if (!hasPty(id)) {
        cleanup()
        res.status(410).json({ error: 'PTY session died while waiting', state: 'dead' })
      }
    })

    const timer = setTimeout(() => {
      if (resolved) return
      cleanup()
      const finalState = getState(id) ?? 'dead'
      res.status(408).json({ error: `Timeout waiting for "${targetState}" (current: "${finalState}")`, state: finalState })
    }, timeout)

    req.on('close', () => { if (!resolved) cleanup() })
  })
}
