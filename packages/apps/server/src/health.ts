import type { IncomingMessage, ServerResponse } from 'node:http'

export type HealthState = {
  ready: boolean
  port: number
  startedAt: number
  dbPath: string
}

/**
 * Handles `GET /health`. Returns true when the request was a health request
 * (so the caller stops processing it), false otherwise.
 */
export function handleHealth(
  state: HealthState,
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  if (req.url !== '/health' || req.method !== 'GET') return false
  if (!state.ready) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end('{"ok":false,"reason":"starting"}')
    return true
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      ok: true,
      port: state.port,
      dbPath: state.dbPath,
      uptimeMs: Date.now() - state.startedAt
    })
  )
  return true
}
