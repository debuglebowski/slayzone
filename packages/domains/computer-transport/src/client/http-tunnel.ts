import { Duplex } from 'node:stream'
import {
  HTTP_TUNNEL_CHUNK,
  HTTP_TUNNEL_PREFIX,
  httpTunnelOpenResultSchema,
  httpTunnelReadResultSchema,
  type HttpTunnelRequester
} from '../shared/http-tunnel'

export async function openHttpTunnel(requester: HttpTunnelRequester): Promise<Duplex> {
  const { id } = httpTunnelOpenResultSchema.parse(
    await requester.request(`${HTTP_TUNNEL_PREFIX}open`)
  )
  let reading = false
  const socket = new Duplex({
    read() {
      if (reading) return
      reading = true
      void (async () => {
        try {
          while (!socket.destroyed) {
            const result = httpTunnelReadResultSchema.parse(
              await requester.request(`${HTTP_TUNNEL_PREFIX}read`, { id })
            )
            const more = result.data ? socket.push(Buffer.from(result.data, 'base64')) : true
            if (result.end) {
              socket.push(null)
              break
            }
            if (!more) break
          }
        } catch (error) {
          socket.destroy(error instanceof Error ? error : new Error(String(error)))
        } finally {
          reading = false
        }
      })()
    },
    write(chunk: Buffer, _encoding, done) {
      void (async () => {
        for (let offset = 0; offset < chunk.length; offset += HTTP_TUNNEL_CHUNK) {
          await requester.request(`${HTTP_TUNNEL_PREFIX}write`, {
            id,
            data: chunk.subarray(offset, offset + HTTP_TUNNEL_CHUNK).toString('base64')
          })
        }
      })().then(() => done(), done)
    },
    final(done) {
      void requester
        .request(`${HTTP_TUNNEL_PREFIX}write`, { id, end: true })
        .then(() => done(), done)
    },
    destroy(error, done) {
      void requester.request(`${HTTP_TUNNEL_PREFIX}close`, { id }).catch(() => {
        // A disconnect already destroyed the hub's copy of this stream.
      })
      done(error)
    }
  })
  Object.assign(socket, {
    setTimeout: () => socket,
    setNoDelay: () => socket,
    setKeepAlive: () => socket
  })
  return socket
}
