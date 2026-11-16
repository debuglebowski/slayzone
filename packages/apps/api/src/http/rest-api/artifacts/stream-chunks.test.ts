import { once } from 'node:events'
import { createServer, get, type ServerResponse } from 'node:http'
import { expect, test, vi } from 'vitest'
import { streamChunks } from './stream-chunks'

test('real HTTP disconnect during backpressure unwinds the reader and removes listeners', async () => {
  let response!: ServerResponse,
    finalized = false,
    completed = false
  let work: Promise<void> | undefined
  const server = createServer((_req, res) => {
    response = res
    async function* chunks() {
      try {
        yield Buffer.alloc(8 * 1024 * 1024)
      } finally {
        finalized = true
      }
    }
    work = streamChunks(res as never, chunks()).then(() => {
      completed = true
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const port = (server.address() as { port: number }).port
    await new Promise<void>((resolve, reject) => {
      const request = get(`http://127.0.0.1:${port}`, (res) => {
        res.pause()
        expect(response.listenerCount('drain')).toBe(1)
        request.destroy()
        resolve()
      })
      request.once('error', reject)
    })
    if (!response.destroyed) await once(response, 'close')
    await vi.waitFor(() => expect(completed).toBe(true), { timeout: 500 })
    expect(finalized).toBe(true)
    expect(response.listenerCount('drain')).toBe(0)
    expect(response.listenerCount('error')).toBe(0)
    expect(response.listenerCount('close')).toBe(0)
  } finally {
    // Only unstick the pre-fix implementation after its regression assertion fails.
    response?.emit('drain')
    await work
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('a slow real HTTP reader receives every byte, with cleanup after successful drains', async () => {
  let response!: ServerResponse,
    finalized = false
  let work: Promise<void> | undefined
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x5a)
  const server = createServer((_req, res) => {
    response = res
    res.setHeader('content-length', bytes.length)
    async function* chunks() {
      try {
        for (let offset = 0; offset < bytes.length; offset += 256 * 1024)
          yield bytes.subarray(offset, offset + 256 * 1024)
      } finally {
        finalized = true
      }
    }
    work = streamChunks(res as never, chunks())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const port = (server.address() as { port: number }).port
    const received = await new Promise<Buffer>((resolve, reject) => {
      get(`http://127.0.0.1:${port}`, (res) => {
        const parts: Buffer[] = []
        res.on('data', (part: Buffer) => {
          parts.push(part)
          res.pause()
          setImmediate(() => res.resume())
        })
        res.once('end', () => resolve(Buffer.concat(parts)))
        res.once('error', reject)
      }).once('error', reject)
    })
    await work
    expect(received).toEqual(bytes)
    expect(finalized).toBe(true)
    expect(response.listenerCount('drain')).toBe(0)
    expect(response.listenerCount('error')).toBe(0)
    expect(response.listenerCount('close')).toBe(0)
  } finally {
    await work
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test.each([false, true])(
  'producer failure cleans reader/listeners (headers already sent=%s)',
  async (sent) => {
    let response!: ServerResponse,
      finalized = false
    let work: Promise<void> | undefined
    const server = createServer((_req, res) => {
      response = res
      res.setHeader('content-length', 512 * 1024)
      async function* chunks() {
        try {
          if (sent) yield Buffer.alloc(256 * 1024)
          throw new Error('disk failed')
        } finally {
          finalized = true
        }
      }
      work = streamChunks(res as never, chunks()).catch((error: Error) => {
        expect(error.message).toBe('disk failed')
        expect(res.headersSent).toBe(false)
        res.removeHeader('content-length')
        res.statusCode = 500
        res.end('failed')
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const port = (server.address() as { port: number }).port
      const result = await fetch(`http://127.0.0.1:${port}`)
        .then(
          async (r) => ({ status: r.status, bytes: (await r.arrayBuffer()).byteLength }),
          () => null
        )
        .catch(() => null)
      await work
      if (!sent) expect(result?.status).toBe(500)
      else expect(result).toBeNull()
      expect(finalized).toBe(true)
      expect(response.listenerCount('drain')).toBe(0)
      expect(response.listenerCount('error')).toBe(0)
      expect(response.listenerCount('close')).toBe(0)
    } finally {
      await work
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
)
