import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Largest request body better-auth's `/api/auth/*` accepts. Its bodies are tiny (an
 * email sign-in, a device-code poll, an Entra form_post callback of a few KB); same
 * cap as a computer's pre-login frames (`PRE_AUTH_FRAME_MAX_BYTES`).
 */
export const AUTH_BODY_MAX_BYTES = 64 * 1024

function refuse(res: ServerResponse, status: 411 | 413, error: string): false {
  // `connection: close`: the unread body must not be parsed as the next request.
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
  res.end(JSON.stringify({ error }))
  return false
}

/**
 * Size gate in front of better-auth, which reads the raw body itself (no Express
 * parser may run before it) and has no limit of its own — so without this an
 * unauthenticated caller could stream an unbounded body into hub memory. A body must
 * declare its length (Node then refuses one that sends more), and that length must fit
 * the cap. Returns true when the request may go on to better-auth; otherwise it has
 * answered (411 / 413).
 */
export function guardAuthRequestBody(req: IncomingMessage, res: ServerResponse): boolean {
  const declared = req.headers['content-length']
  if (req.headers['transfer-encoding'] !== undefined && declared === undefined) {
    return refuse(res, 411, 'A request body must declare its length')
  }
  if (declared !== undefined && Number(declared) > AUTH_BODY_MAX_BYTES) {
    return refuse(res, 413, 'Request body too large')
  }
  return true
}
