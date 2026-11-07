// @vitest-environment node
/**
 * The direct WebSocket's keepalive (docs/direct-link.md), against a real `ws` server.
 * Node environment: jsdom's WebSocket does not report a client-side close the way
 * Chromium's and Node's do.
 */
import { describe, expect, it } from 'vitest'
import { openDirectConnection } from './direct-link'

// M2: a half-open socket (NAT dropped the flow, a network switch) sends no FIN, so
// without client pings the client never learns it is dead. Keepalive closes it, and
// the manager then drops its leases back to the relay.
describe('direct connection keepalive', () => {
  async function server(answerPings: boolean) {
    const { WebSocketServer } = await import('ws')
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        if (answerPings && String(raw) === 'PING') ws.send('PONG')
      })
    })
    const { port } = wss.address() as { port: number }
    return { url: `ws://127.0.0.1:${port}/direct/v1`, close: () => wss.close() }
  }

  it('closes a socket whose peer stops answering pings', async () => {
    const s = await server(false)
    const conn = openDirectConnection({
      url: s.url,
      token: 't',
      probe: async () => true,
      keepAlive: { intervalMs: 40, pongTimeoutMs: 40 }
    })
    try {
      // A subscription makes the client open its socket.
      conn.client.ping.query().catch(() => undefined)
      const closed = await new Promise<boolean>((r) => {
        conn.onClose(() => r(true))
        setTimeout(() => r(false), 2_000)
      })
      expect(closed).toBe(true)
    } finally {
      conn.close()
      s.close()
    }
  })

  it('keeps a socket whose peer answers', async () => {
    const s = await server(true)
    const conn = openDirectConnection({
      url: s.url,
      token: 't',
      probe: async () => true,
      keepAlive: { intervalMs: 40, pongTimeoutMs: 40 }
    })
    let closed = false
    conn.onClose(() => {
      closed = true
    })
    try {
      conn.client.ping.query().catch(() => undefined)
      await new Promise((r) => setTimeout(r, 400))
      expect(closed).toBe(false)
    } finally {
      conn.close()
      s.close()
    }
  })
})
