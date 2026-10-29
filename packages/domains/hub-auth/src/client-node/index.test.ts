/**
 * The Node transport against a real local HTTP server: what reaches the hub (no Fetch
 * Metadata, no Origin — better-auth's non-browser path, else `403
 * MISSING_OR_NULL_ORIGIN`), how answers, caps, timeouts and dead hosts come back, and one
 * real sign-in exchange through the shared client.
 */
import {
  createServer,
  type IncomingHttpHeaders,
  type RequestListener,
  type Server
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { isHubTransportTimeout, requestDeviceCode, signInWithPassword } from '../client'
import { nodeHubTransport } from './index'

let server: Server | null = null

afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
})

function listen(handler: RequestListener): Promise<string> {
  server = createServer(handler)
  return new Promise((resolve) =>
    server!.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`)
    )
  )
}

const seen: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders; body: string }> =
  []
const recordAnd =
  (reply: (res: Parameters<RequestListener>[1]) => void): RequestListener =>
  (req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      reply(res)
    })
  }

afterEach(() => {
  seen.length = 0
})

describe('nodeHubTransport', () => {
  it('POSTs JSON with content-type + content-length and no Fetch Metadata or Origin', async () => {
    const base = await listen(
      recordAnd((res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'set-auth-token': 'tok-1' })
        res.end('{"ok":true}')
      })
    )
    const body = JSON.stringify({ email: 'åda@example.com', password: 'pw' })
    const res = await nodeHubTransport({
      method: 'POST',
      url: `${base}/api/auth/sign-in/email`,
      headers: { 'content-type': 'application/json' },
      body,
      timeoutMs: 5000,
      maxResponseChars: 65536
    })
    expect(res.status).toBe(200)
    expect(res.text).toBe('{"ok":true}')
    expect(res.header('Set-Auth-Token')).toBe('tok-1')
    expect(res.header('x-missing')).toBeNull()
    const [req] = seen
    expect(req!.method).toBe('POST')
    expect(req!.url).toBe('/api/auth/sign-in/email')
    expect(req!.body).toBe(body)
    expect(req!.headers['content-type']).toBe('application/json')
    expect(req!.headers['content-length']).toBe(String(Buffer.byteLength(body)))
    expect(req!.headers['sec-fetch-mode']).toBeUndefined()
    expect(req!.headers.origin).toBeUndefined()
    expect(req!.headers.cookie).toBeUndefined()
  })

  it('GETs with the given headers; any status resolves; redirects are not followed', async () => {
    const base = await listen(
      recordAnd((res) => {
        res.writeHead(302, { location: '/elsewhere' })
        res.end()
      })
    )
    const res = await nodeHubTransport({
      method: 'GET',
      url: `${base}/api/auth/get-session`,
      headers: { authorization: 'Bearer t' },
      timeoutMs: 5000,
      maxResponseChars: 100
    })
    expect(res.status).toBe(302)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.method).toBe('GET')
    expect(seen[0]!.headers.authorization).toBe('Bearer t')
    expect(seen[0]!.headers['content-length']).toBeUndefined()
  })

  it('caps the body near maxResponseChars', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200)
      res.write('a'.repeat(3000))
      res.write('b'.repeat(3000))
      res.end('c'.repeat(3000))
    })
    const res = await nodeHubTransport({
      method: 'GET',
      url: `${base}/health`,
      headers: {},
      timeoutMs: 5000,
      maxResponseChars: 4096
    })
    expect(res.text.length).toBeGreaterThanOrEqual(4096)
    expect(res.text.length).toBeLessThan(9000)
    expect(res.text).not.toContain('c')
  })

  it('a wedged hub rejects with the timeout error', async () => {
    const base = await listen(() => {
      /* never answer */
    })
    const err = await nodeHubTransport({
      method: 'GET',
      url: `${base}/health`,
      headers: {},
      timeoutMs: 150,
      maxResponseChars: 4096
    }).catch((e: unknown) => e)
    expect(isHubTransportTimeout(err)).toBe(true)
    expect((err as Error).message).toBe('timed out after 150ms')
  })

  it('a dead port rejects with the connection error', async () => {
    const base = await listen(() => {})
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
    const err = await nodeHubTransport({
      method: 'GET',
      url: `${base}/health`,
      headers: {},
      timeoutMs: 5000,
      maxResponseChars: 4096
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(isHubTransportTimeout(err)).toBe(false)
    expect((err as NodeJS.ErrnoException).code).toBe('ECONNREFUSED')
  })
})

describe('the shared client over nodeHubTransport', () => {
  it('password sign-in and a device code over real HTTP', async () => {
    const base = await listen(
      recordAnd((res) => {
        const last = seen[seen.length - 1]!
        if (last.url === '/api/auth/sign-in/email') {
          res.writeHead(200, { 'set-auth-token': 'bearer-x' })
          res.end('{}')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'WXYZ1234',
            verification_uri: `${base}/device`,
            expires_in: 600,
            interval: 5
          })
        )
      })
    )
    expect(
      await signInWithPassword(nodeHubTransport, base, { email: 'a@b.c', password: 'p' })
    ).toEqual({ ok: true, token: 'bearer-x' })
    expect(await requestDeviceCode(nodeHubTransport, base, 'slayzone-cli')).toMatchObject({
      ok: true,
      userCode: 'WXYZ-1234',
      verificationUri: `${base}/device`
    })
    expect(JSON.parse(seen[1]!.body)).toEqual({ client_id: 'slayzone-cli' })
  })
})
