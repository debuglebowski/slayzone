/**
 * Tests for guardAuthRequestBody — the size cap in front of better-auth's `/api/auth/*`.
 *
 * better-auth reads the raw request body itself (no Express parser in front of it), with
 * no limit, so an unauthenticated caller could stream an unbounded body into hub memory.
 * The guard refuses a declared length over the cap (413) and a body with no declared
 * length (411); Node enforces that the bytes received match the declared length.
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { afterAll, expect, test } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AUTH_BODY_MAX_BYTES, guardAuthRequestBody } from './auth-body-limit'

/** Stands in for better-auth: echoes how many body bytes it read. */
const server: Server = createServer((req, res) => {
  if (!guardAuthRequestBody(req, res)) return
  let n = 0
  req.on('data', (c: Buffer) => (n += c.length))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(String(n))
  })
})
await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
const port = (server.address() as AddressInfo).port
afterAll(() => new Promise<void>((closed) => server.close(() => closed())))

function send(
  method: string,
  body: Buffer | null,
  opts: { chunked?: boolean } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (body && !opts.chunked) headers['content-length'] = String(body.length)
    const req = request(
      { host: '127.0.0.1', port, method, path: '/api/auth/sign-in/email', agent: false, headers },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => (data += c))
        res.on('end', () => done({ status: res.statusCode ?? 0, body: data }))
      }
    )
    // A refused upload is cut off mid-write; the response is what the test reads.
    req.on('error', (err) => ((err as NodeJS.ErrnoException).code === 'EPIPE' ? null : fail(err)))
    if (body && opts.chunked) req.write(body)
    req.end(body && !opts.chunked ? body : undefined)
  })
}

test('a normal sign-in body passes through untouched', async () => {
  const body = Buffer.from(JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(40) }))
  const res = await send('POST', body)
  expect(res.status, 'status').toBe(200)
  expect(res.body, 'bytes the handler read').toBe(String(body.length))
})

test('a body exactly at the cap passes', async () => {
  const res = await send('POST', Buffer.alloc(AUTH_BODY_MAX_BYTES, 0x20))
  expect(res.status, 'status').toBe(200)
})

test('a declared length over the cap → 413, handler never reads it', async () => {
  const res = await send('POST', Buffer.alloc(AUTH_BODY_MAX_BYTES + 1, 0x20))
  expect(res.status, 'status').toBe(413)
})

test('a body with no declared length (chunked) → 411', async () => {
  const res = await send('POST', Buffer.from('{"email":"a@b.c"}'), { chunked: true })
  expect(res.status, 'status').toBe(411)
})

test('a request with no body (GET callback) passes', async () => {
  const res = await send('GET', null)
  expect(res.status, 'status').toBe(200)
  expect(res.body, 'bytes').toBe('0')
})
