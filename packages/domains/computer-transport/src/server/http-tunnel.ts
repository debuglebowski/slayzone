import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { duplexPair, type Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import {
  HTTP_TUNNEL_CHUNK,
  HTTP_TUNNEL_PREFIX,
  httpTunnelParamsSchema
} from '../shared/http-tunnel'

/** Private HTTP parser: never listens on a network interface. All sockets come
 * from an authenticated computer, and each carries exactly one CLI request. */
export function createHttpTunnelServer(
  dispatch: (computerId: string, req: IncomingMessage, res: ServerResponse) => void
) {
  const streams = new Map<
    string,
    {
      computerId: string
      socket: Duplex
      peer: Duplex
      reading: boolean
      writing: boolean
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const remove = (id: string): void => {
    const stream = streams.get(id)
    if (!stream) return
    streams.delete(id)
    clearTimeout(stream.timer)
    stream.socket.destroy()
    stream.peer.destroy()
  }
  return {
    async request(computerId: string, method: string, params?: unknown): Promise<unknown> {
      if (method === `${HTTP_TUNNEL_PREFIX}open`) {
        if ([...streams.values()].filter((s) => s.computerId === computerId).length >= 32) {
          throw new Error('Too many CLI relay requests')
        }
        const id = randomUUID()
        const [socket, peer] = duplexPair()
        // node:http accepts a Duplex for custom transports; these TCP tuning
        // methods have no meaning on an in-memory socket.
        Object.assign(peer, {
          setTimeout: () => peer,
          setNoDelay: () => peer,
          setKeepAlive: () => peer
        })
        const timer = setTimeout(() => remove(id), 120_000)
        timer.unref()
        streams.set(id, { computerId, socket, peer, reading: false, writing: false, timer })
        socket.on('error', () => remove(id))
        peer.on('error', () => remove(id))
        // One parser per stream; identity never comes from a forwarded header.
        let requested = false
        const parser = createServer((req, res) => {
          if (requested) {
            remove(id)
            return
          }
          requested = true
          res.shouldKeepAlive = false
          dispatch(computerId, req, res)
        })
        parser.on('clientError', () => remove(id))
        parser.emit('connection', peer)
        return { id }
      }
      const { id, data, end } = httpTunnelParamsSchema.parse(params)
      const stream = streams.get(id)
      if (!stream || stream.computerId !== computerId)
        throw new Error('CLI relay request is closed')
      stream.timer.refresh()
      if (method === `${HTTP_TUNNEL_PREFIX}close`) {
        remove(id)
        return {}
      }
      if (method === `${HTTP_TUNNEL_PREFIX}write`) {
        if (stream.writing) throw new Error('Concurrent CLI relay writes are not allowed')
        stream.writing = true
        try {
          const bytes = Buffer.from(data ?? '', 'base64')
          if (bytes.length > HTTP_TUNNEL_CHUNK) throw new Error('CLI relay chunk too large')
          await new Promise<void>((resolve, reject) => {
            const done = (error?: Error | null) => (error ? reject(error) : resolve())
            if (end) stream.socket.end(bytes, done)
            else stream.socket.write(bytes, done)
          })
          return {}
        } finally {
          stream.writing = false
        }
      }
      if (method === `${HTTP_TUNNEL_PREFIX}read`) {
        if (stream.reading) throw new Error('Concurrent CLI relay reads are not allowed')
        stream.reading = true
        try {
          return await new Promise<{ data: string; end: boolean }>((resolve, reject) => {
            const clean = () => {
              clearTimeout(timer)
              stream.socket.off('readable', ready)
              stream.socket.off('end', ready)
              stream.socket.off('close', closed)
            }
            const ready = () => {
              const bytes = stream.socket.read(
                Math.min(stream.socket.readableLength, HTTP_TUNNEL_CHUNK)
              ) as Buffer | null
              if (bytes?.length || stream.socket.readableEnded) {
                clean()
                resolve({ data: bytes?.toString('base64') ?? '', end: stream.socket.readableEnded })
              }
            }
            const closed = () => {
              if (stream.socket.readableEnded) ready()
              else {
                clean()
                reject(new Error('CLI relay disconnected'))
              }
            }
            // Long polling keeps idle SSE streams alive without an unbounded RPC timeout.
            const timer = setTimeout(() => {
              clean()
              resolve({ data: '', end: false })
            }, 20_000)
            stream.socket.on('readable', ready).once('end', ready).once('close', closed)
            if (stream.socket.destroyed && !stream.socket.readableEnded) closed()
            else ready()
          })
        } finally {
          stream.reading = false
        }
      }
      throw new Error('Unsupported CLI relay method')
    },
    disconnect(computerId: string): void {
      for (const [id, stream] of streams) if (stream.computerId === computerId) remove(id)
    },
    close(): void {
      for (const id of streams.keys()) remove(id)
    }
  }
}
