import type { Express, Response } from 'express'
import type { ProcessStartResult, RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'
import { refusedHubProcesses } from '../switch-refusal'

/** A refused start/restart, as HTTP: unknown id 404, a running row 409 (use
 *  restart), the app going down 503. */
const REFUSAL_STATUS = {
  'not-found': 404,
  'already-running': 409,
  'shutting-down': 503,
  'no-computer': 503,
  'old-run-survives': 409
} as const
const REFUSAL_MESSAGE = {
  'not-found': 'Process not found',
  'already-running': 'Process is already running — restart it instead',
  'shutting-down': 'The app is shutting down',
  'no-computer': 'No computer is connected to run this process. Connect a computer.',
  'old-run-survives':
    'The previous run is still alive on its computer (it outlived SIGKILL) — stop it first'
} as const

function answerStart(res: Response, id: string, result: ProcessStartResult): void {
  if (!result.ok) {
    res
      .status(REFUSAL_STATUS[result.reason])
      .json({ error: REFUSAL_MESSAGE[result.reason], reason: result.reason })
    return
  }
  res.json({ ok: true, id, pid: result.pid, status: result.status })
}

/**
 * Lifecycle of an existing process row, for `slay processes start|stop|restart`.
 * The row (its command, cwd) is stored; these never take a command from the
 * caller. `DELETE /api/processes/:id` (delete.ts) is the one that removes the row.
 */
export function registerProcessesLifecycleRoutes(app: Express, deps: RestApiDeps): void {
  app.post('/api/processes/:id/start', async (req, res) => {
    if (refusedHubProcesses(res, 'start')) return
    if (!deps.processes) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    answerStart(res, req.params.id, await deps.processes.start(req.params.id))
  })

  app.post('/api/processes/:id/restart', async (req, res) => {
    if (refusedHubProcesses(res, 'restart')) return
    if (!deps.processes) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    answerStart(res, req.params.id, await deps.processes.restart(req.params.id))
  })

  app.post('/api/processes/:id/stop', async (req, res) => {
    if (refusedHubProcesses(res, 'stop')) return
    if (!deps.processes) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    if (!(await deps.processes.stop(req.params.id))) {
      res.status(404).json({ error: 'Process not found', reason: 'not-found' })
      return
    }
    const proc = deps.processes.listAll().find((p) => p.id === req.params.id)
    res.json({ ok: true, id: req.params.id, status: proc?.status ?? 'stopped' })
  })
}
