import { WebSocket, WebSocketServer, type RawData } from 'ws'

/** Real loopback transport with a deterministic gate on one workspace chunk.
 * Heartbeats and unrelated RPCs continue while that request is held. */
export async function createComputerLink() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('Computer relay has no port')
  let upstreamUrl = ''
  let enabled = true
  const sockets = new Set<WebSocket>()
  let gate: { hit(): void; held?: () => void } | null = null
  const buffer = (data: RawData) =>
    Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Uint8Array)
  server.on('connection', (computer) => {
    if (!enabled || !upstreamUrl) {
      computer.terminate()
      return
    }
    const hub = new WebSocket(upstreamUrl)
    sockets.add(computer)
    sockets.add(hub)
    const queued: Array<{ data: Buffer; binary: boolean }> = []
    computer.on('error', () => undefined)
    hub.on('error', () => computer.terminate())
    computer.on('close', () => {
      sockets.delete(computer)
      hub.terminate()
    })
    hub.on('close', () => {
      sockets.delete(hub)
      computer.terminate()
    })
    computer.on('message', (raw, binary) => {
      const data = buffer(raw)
      if (hub.readyState === WebSocket.OPEN) hub.send(data, { binary })
      else queued.push({ data, binary })
    })
    hub.on('open', () => {
      for (const item of queued.splice(0)) hub.send(item.data, { binary: item.binary })
    })
    hub.on('message', (raw, binary) => {
      const data = buffer(raw)
      const forward = () => {
        if (computer.readyState === WebSocket.OPEN) computer.send(data, { binary })
      }
      if (gate && !gate.held && !binary) {
        const frame = JSON.parse(data.toString()) as { method?: string; params?: { op?: string } }
        if (frame.method === 'workspace.move' && frame.params?.op === 'write') {
          gate.held = forward
          gate.hit()
          return
        }
      }
      forward()
    })
  })
  return {
    route(url: string) {
      upstreamUrl = url
      return `ws://127.0.0.1:${address.port}/computers`
    },
    holdNextWrite() {
      if (gate) throw new Error('Computer relay already has an armed gate')
      let hit!: () => void
      const reached = new Promise<void>((resolve) => {
        hit = resolve
      })
      gate = { hit }
      return reached
    },
    release() {
      const held = gate?.held
      gate = null
      held?.()
    },
    disconnect() {
      enabled = false
      gate = null
      for (const socket of sockets) socket.terminate()
    },
    reconnect() {
      enabled = true
    },
    async close() {
      enabled = false
      gate = null
      for (const socket of sockets) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
