// @vitest-environment node
/**
 * The hub WebSocket's keepalive, against a real `ws` server. A half-open socket
 * (NAT dropped the flow, sleep/wake, a network switch) sends no FIN: without
 * client pings the app never learns it is dead, so its subscriptions never
 * restart and a chat panel never catches up (`onStarted` → catch-up).
 */
import { describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createTrpcWsClient } from './runtime'

async function hub(answerPings: boolean) {
  const { WebSocketServer } = await import('ws')
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  let connections = 0
  wss.on('connection', (ws) => {
    connections++
    ws.on('message', (raw) => {
      if (answerPings && String(raw) === 'PING') ws.send('PONG')
    })
  })
  const { port } = wss.address() as AddressInfo
  return {
    url: `ws://127.0.0.1:${port}/trpc`,
    connections: () => connections,
    close: () => wss.close()
  }
}

describe('hub connection keepalive', () => {
  it('drops a socket whose hub stops answering pings, and connects again', async () => {
    const s = await hub(false)
    const { wsClient, client } = createTrpcWsClient({
      url: s.url,
      keepAlive: { intervalMs: 40, pongTimeoutMs: 40 }
    })
    try {
      ;(client as unknown as { x: { query: () => Promise<unknown> } }).x
        .query()
        .catch(() => undefined)
      const deadline = Date.now() + 3_000
      while (s.connections() < 2 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 20))
      expect(s.connections()).toBeGreaterThanOrEqual(2)
    } finally {
      wsClient.close()
      s.close()
    }
  })

  it('keeps a socket whose hub answers', async () => {
    const s = await hub(true)
    const { wsClient, client } = createTrpcWsClient({
      url: s.url,
      keepAlive: { intervalMs: 40, pongTimeoutMs: 40 }
    })
    try {
      ;(client as unknown as { x: { query: () => Promise<unknown> } }).x
        .query()
        .catch(() => undefined)
      await new Promise((r) => setTimeout(r, 400))
      expect(s.connections()).toBe(1)
    } finally {
      wsClient.close()
      s.close()
    }
  })
})
