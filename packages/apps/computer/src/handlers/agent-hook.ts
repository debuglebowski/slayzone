/** Computer-local hook capture. Only lifecycle facts cross the authenticated hub link. */
import http from 'node:http'
import {
  resolveAgentHook,
  sanitizeAgentHook,
  type ResolvedAgentHook
} from '@slayzone/terminal-contracts'
import {
  AGENT_HOOK_EVENT_NAME,
  ComputerNotificationMethods
} from '@slayzone/computer-transport/shared'
import type { HandlerContext } from './types'

/** Loopback path the overlaid SLAYZONE_AGENT_HOOK_URL points at. */
const AGENT_HOOK_PATH = '/api/agent-hook'

/** Cap the body we buffer — a SessionStart payload can carry the full tool list,
 *  but anything past ~2 MiB is not a real hook and we drop it rather than buffer
 *  unbounded. Mirrors the server route's generous-but-bounded 1mb+ limit. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

export interface AgentHookServer {
  /** `http://127.0.0.1:<port>/api/agent-hook` — inject as SLAYZONE_AGENT_HOOK_URL. */
  url: string
  /** Stop the listener (called on computer shutdown). */
  close(): Promise<void>
}

/**
 * Start the computer's loopback agent-hook relay. Binds `127.0.0.1:0` (ephemeral
 * port) so it never collides, and resolves once the port is bound.
 */
export function createAgentHookServer(
  ctx: HandlerContext,
  onHook?: (hook: ResolvedAgentHook) => void
): Promise<AgentHookServer> {
  const server = http.createServer((req, res) => {
    // Only the hook path + POST are meaningful; everything else is a fast 404.
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== AGENT_HOOK_PATH) {
      res.writeHead(404).end()
      return
    }

    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    req.on('data', (c: Buffer) => {
      if (aborted) return
      total += c.length
      if (total > MAX_BODY_BYTES) {
        aborted = true
        // Still answer 200 (fire-and-forget contract) but skip the relay.
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (aborted) return

      const bodyText = Buffer.concat(chunks).toString('utf8')
      // Parse locally; malformed bodies never cross the hub link.
      let payload: unknown
      try {
        payload = bodyText.length > 0 ? JSON.parse(bodyText) : {}
      } catch {
        payload = bodyText
      }
      const hook = resolveAgentHook(payload)
      if (!hook) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
        return
      }
      try {
        onHook?.(hook)
      } catch {
        res
          .writeHead(503, { 'content-type': 'application/json' })
          .end('{"error":"Local prompt storage unavailable"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      try {
        ctx.dialer.notify(ComputerNotificationMethods.event, {
          name: AGENT_HOOK_EVENT_NAME,
          payload: sanitizeAgentHook(hook)
        })
      } catch {
        ctx.log('agent-hook relay failed')
      }
    })
    req.on('error', () => {
      if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })

  return new Promise<AgentHookServer>((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      ctx.log('agent-hook loopback relay listening', { port })
      resolve({
        url: `http://127.0.0.1:${port}${AGENT_HOOK_PATH}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r())
          })
      })
    })
  })
}
