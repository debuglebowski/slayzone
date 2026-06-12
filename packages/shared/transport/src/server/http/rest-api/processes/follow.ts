import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'

export function registerProcessesFollowRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/processes/:id/follow', (req, res) => {
    if (!deps.processes) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    const proc = deps.processes.listAll().find((p) => p.id === req.params.id)
    if (!proc) {
      res.status(404).json({ error: `Process not found` })
      return
    }

    // Already finished: dump buffer and close
    if (proc.status !== 'running') {
      res.setHeader('Content-Type', 'text/plain')
      res.end(proc.logBuffer.join('\n'))
      return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.flushHeaders()

    for (const line of proc.logBuffer) res.write(`data: ${line}\n\n`)

    const unsub = deps.processes.subscribeToLogs(proc.id, (line) => {
      res.write(`data: ${line}\n\n`)
    })

    req.on('close', unsub)
  })
}
