/**
 * `slay computer mint` at the command level (T-20): `--for <user>` names who the
 * computer is for, `--ttl` is capped at the hub's 60 minutes before anything is sent,
 * and a hub with login refusing a mint that names nobody comes back with how to fix it.
 *
 * The hub is a fake HTTP server on loopback, addressed through `SLAYZONE_HUB_ADDRESS`,
 * that answers `POST /api/computers/join-token` the way a hub with login does (400
 * `JOIN_TOKEN_OWNER_REQUIRED` without `forUser`). The real route's rules are covered
 * by transport's `rest-api/computers/join-token.test.ts`. Pure Node.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { captureAllAsync } from '../../test/test-harness'
import { computerCommand } from './computer'

interface Seen {
  auth: string | null
  body: Record<string, unknown>
}

const TOKEN = `szjt1.${Buffer.from(JSON.stringify({ hubUrl: 'wss://hub.example/computers', secret: 's' })).toString('base64url')}`

async function startHub(): Promise<{ port: number; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      seen.push({ auth: req.headers.authorization ?? null, body })
      res.setHeader('content-type', 'application/json')
      if (req.method !== 'POST' || req.url !== '/api/computers/join-token') {
        res.statusCode = 404
        res.end('{}')
      } else if (typeof body.forUser !== 'string') {
        res.statusCode = 400
        res.end(
          JSON.stringify({
            error: 'name the user this computer is for',
            code: 'JOIN_TOKEN_OWNER_REQUIRED'
          })
        )
      } else {
        res.end(JSON.stringify({ token: TOKEN, hubUrl: 'wss://hub.example/computers' }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { port, seen, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

function mint(args: string[]) {
  return captureAllAsync(async () => {
    await computerCommand().parseAsync(['mint', ...args], { from: 'user' })
  })
}

type MintOut = Awaited<ReturnType<typeof mint>>

describe('slay computer mint (T-20)', () => {
  let hub: Awaited<ReturnType<typeof startHub>>
  const saved = { addr: process.env.SLAYZONE_HUB_ADDRESS, token: process.env.SLAYZONE_HUB_TOKEN }
  beforeAll(async () => {
    hub = await startHub()
    process.env.SLAYZONE_HUB_ADDRESS = `127.0.0.1:${hub.port}`
    process.env.SLAYZONE_HUB_TOKEN = 'admin-bearer'
  })
  afterAll(async () => {
    if (saved.addr === undefined) delete process.env.SLAYZONE_HUB_ADDRESS
    else process.env.SLAYZONE_HUB_ADDRESS = saved.addr
    if (saved.token === undefined) delete process.env.SLAYZONE_HUB_TOKEN
    else process.env.SLAYZONE_HUB_TOKEN = saved.token
    await hub?.close()
  })

  describe('--for', () => {
    let out: MintOut
    let sent: Seen | undefined
    beforeAll(async () => {
      out = await mint(['lab-box', '--for', 'bob@example.com', '--json'])
      sent = hub.seen.at(-1)
    })
    test('--for: exits 0', () => {
      expect(out.exitCode, out.stderr.join('\n')).toBeNull()
    })
    test('--for: sends forUser, the label and the default 15 minutes, as the signed-in caller', () => {
      expect(sent).toMatchObject({
        auth: 'Bearer admin-bearer',
        body: { forUser: 'bob@example.com', label: 'lab-box', ttlMs: 15 * 60_000 }
      })
    })
    test('--for: prints the token', () => {
      expect((JSON.parse(out.stdout.join('\n')) as { token?: string }).token).toBe(TOKEN)
    })
  })

  test('text output names who it is for', async () => {
    const out = await mint(['lab-box', '--for', 'u-bob'])
    expect(out.stdout).toContain('For:   u-bob')
  })

  describe('no --for on a hub with login', () => {
    let out: MintOut
    let err: string
    let sent: Seen | undefined
    beforeAll(async () => {
      out = await mint(['lab-box', '--json'])
      err = out.stderr.join('\n')
      sent = hub.seen.at(-1)
    })
    test('no --for on a hub with login: exits 1', () => {
      expect(out.exitCode).toBe(1)
    })
    test('…says what the hub said', () => {
      expect(err).toContain('name the user this computer is for')
    })
    test('…and how to fix it', () => {
      expect(err).toContain('slay computer mint lab-box --for <email>')
      expect(err).toContain('slay hub users ls')
    })
    test('…having sent no forUser', () => {
      expect(sent?.body ?? {}).not.toHaveProperty('forUser')
    })
  })

  describe('--ttl over 60 minutes', () => {
    let out: MintOut
    let err: string
    let before: number
    beforeAll(async () => {
      before = hub.seen.length
      out = await mint(['lab-box', '--for', 'u-bob', '--ttl', '61'])
      err = out.stderr.join('\n')
    })
    test('--ttl over 60 minutes: exits 1', () => {
      expect(out.exitCode).toBe(1)
    })
    test('…naming the cap', () => {
      expect(err).toContain('at most 60 minutes')
    })
    test('…before calling the hub', () => {
      expect(hub.seen.length).toBe(before)
    })
  })

  describe('--ttl 60', () => {
    let out: MintOut
    let sent: Seen | undefined
    beforeAll(async () => {
      out = await mint(['lab-box', '--for', 'u-bob', '--ttl', '60', '--json'])
      sent = hub.seen.at(-1)
    })
    test('--ttl 60: allowed', () => {
      expect(out.exitCode, out.stderr.join('\n')).toBeNull()
    })
    test('…sent as 1 hour', () => {
      expect(sent?.body.ttlMs).toBe(60 * 60_000)
    })
  })

  test('blank --for: exits 1 before calling the hub', async () => {
    const before = hub.seen.length
    const out = await mint(['lab-box', '--for', '   '])
    expect(out.exitCode).toBe(1)
    expect(hub.seen.length).toBe(before)
  })
})
