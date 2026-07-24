/**
 * Runner-side agent-hook loopback relay.
 *
 * Hub/runner split: a task's PTY that spawns on a runner must post its lifecycle
 * hook to the SAME place a local spawn does — loopback. There is no hub on the
 * runner machine, so this hosts `/api/agent-hook` on the RUNNER's own loopback
 * and relays each envelope to the hub OVER THE EXISTING authenticated ws channel
 * (a generic `event` notification, `name: 'agent-hook'`). The hub's composition
 * root consumes that event and feeds it to the shared `processAgentHook`.
 *
 * Why this exists (the sustainable topology):
 *   - The agent env is BYTE-IDENTICAL local vs remote — the runner overlays
 *     SLAYZONE_AGENT_HOOK_URL to this loopback URL at pty spawn (see pty.ts), so
 *     `buildMcpEnv` never needs a remote branch for the hook and no per-agent hub
 *     bearer is ever placed in a subprocess env.
 *   - The runner reuses its ONE authed hub link (no second auth path invented).
 *   - This is where a runner could later filter/batch/retry hook traffic.
 *
 * This module is a DUMB PIPE: it does NOT parse or name any field of the hook
 * payload. It reads the raw body, forwards it opaquely, and always answers a
 * fast `{}` (fire-and-forget — the hook must never block the agent TUI).
 *
 * @module runner/handlers/agent-hook
 */

import http from 'node:http'
import { AGENT_HOOK_EVENT_NAME, RunnerNotificationMethods } from '@slayzone/runner-transport/shared'
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
  /** Stop the listener (called on runner shutdown). */
  close(): Promise<void>
}

/**
 * Start the runner's loopback agent-hook relay. Binds `127.0.0.1:0` (ephemeral
 * port) so it never collides, and resolves once the port is bound.
 */
export function createAgentHookServer(ctx: HandlerContext): Promise<AgentHookServer> {
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
      // Answer FIRST — the hook is fire-and-forget and must never block on the
      // hub round-trip. Then relay opaquely.
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')

      const bodyText = Buffer.concat(chunks).toString('utf8')
      // Forward the payload as parsed JSON when possible (the common path — the
      // hub's schema validates an object), else forward the raw string so the
      // hub still sees SOMETHING (it is the single authority that judges shape).
      let payload: unknown
      try {
        payload = bodyText.length > 0 ? JSON.parse(bodyText) : {}
      } catch {
        payload = bodyText
      }
      try {
        ctx.dialer.notify(RunnerNotificationMethods.event, {
          name: AGENT_HOOK_EVENT_NAME,
          payload
        })
      } catch (err) {
        ctx.log('agent-hook relay failed', { error: String(err) })
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
