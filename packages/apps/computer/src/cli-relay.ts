import http from 'node:http'
import type { Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { openHttpTunnel } from '@slayzone/computer-transport/client'
import type { HttpTunnelRequester } from '@slayzone/computer-transport/shared'

export interface CliRelayCapability {
  token: string
  revoke(): void
}
export interface ComputerCliRelay {
  url: string
  issue(): CliRelayCapability
  disconnect(): void
  close(): Promise<void>
}

/** Connection-specific headers belong to the private hub hop, not the CLI's
 * loopback connection. node:http reconstructs transfer framing on this side. */
function responseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const excluded = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    ...(headers.connection ?? '').split(',').map((name) => name.trim().toLowerCase())
  ])
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name)))
}

/** Local capabilities grant only this computer's user-facing CLI relay, never a
 * reusable hub credential. Their lifetime belongs to the spawned session. */
export async function createComputerCliRelay(
  requester: HttpTunnelRequester
): Promise<ComputerCliRelay> {
  const tokens = new Map<string, Set<http.ServerResponse>>()
  const responses = new Set<http.ServerResponse>()
  const active = new Set<http.ClientRequest>()
  const server = http.createServer((req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
    const requests = tokens.get(token)
    if (!requests) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          error: 'CLI relay capability is missing or expired. Open a new task terminal.'
        })
      )
      return
    }
    if (responses.size >= 32) {
      res.writeHead(429).end('Too many CLI relay requests')
      return
    }
    let upstream: http.ClientRequest | undefined
    let receivedResponse = false
    let cancelled = false
    responses.add(res)
    requests.add(res)
    res.on('close', () => {
      responses.delete(res)
      requests.delete(res)
      cancelled = true
      upstream?.destroy()
    })
    void openHttpTunnel(requester)
      .then((socket) => {
        if (cancelled || !tokens.has(token)) {
          socket.destroy()
          return
        }
        // No browser cookies, bearer, proxy identity, or hop-by-hop routing headers
        // cross the relay. HTTP framing is reconstructed by node:http.
        const headers: http.OutgoingHttpHeaders = { connection: 'close' }
        for (const name of ['content-type', 'content-length', 'accept', 'last-event-id']) {
          if (req.headers[name] !== undefined) headers[name] = req.headers[name]
        }
        const agent = new http.Agent({ keepAlive: false })
        agent.createConnection = () => socket as Socket
        upstream = http.request(
          {
            host: 'relay',
            path: req.url,
            method: req.method,
            headers,
            agent
          },
          (response) => {
            receivedResponse = true
            const stopUpload = () => {
              req.unpipe(upstream)
              req.resume()
            }
            // A refusal may arrive while the CLI is still uploading. Drain the
            // local body without forwarding more bytes into a closed hub hop.
            if ((response.statusCode ?? 502) >= 400) stopUpload()
            response.on('end', stopUpload)
            res.writeHead(response.statusCode ?? 502, responseHeaders(response.headers))
            response.on('error', () => res.destroy())
            response.pipe(res)
          }
        )
        active.add(upstream)
        const current = upstream
        upstream.on('close', () => {
          active.delete(current)
          agent.destroy()
        })
        upstream.on('error', () => {
          // Once headers arrived, the response stream decides whether its body
          // completed. An upload EPIPE must not replace a valid hub refusal.
          if (receivedResponse) return
          if (res.headersSent) res.destroy()
          else
            res.writeHead(503, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                error:
                  'CLI relay lost its hub connection. Check the computer connection, then retry.'
              })
            )
        })
        req.on('aborted', () => upstream?.destroy())
        req.pipe(upstream)
      })
      .catch(() => {
        if (!res.headersSent)
          res.writeHead(503, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              error:
                'CLI relay unavailable. Check the computer connection and update hub and computer together.'
            })
          )
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('CLI relay failed to bind')
  const disconnect = () => {
    for (const response of responses) {
      if (response.headersSent) response.destroy()
      else
        response.writeHead(503, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: 'CLI relay lost its hub connection. Check the computer connection, then retry.'
          })
        )
    }
    for (const request of active) request.destroy(new Error('hub disconnected'))
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    issue() {
      const token = randomBytes(32).toString('hex')
      const requests = new Set<http.ServerResponse>()
      tokens.set(token, requests)
      return {
        token,
        revoke() {
          tokens.delete(token)
          for (const response of requests) response.destroy()
        }
      }
    },
    disconnect,
    async close() {
      tokens.clear()
      disconnect()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
