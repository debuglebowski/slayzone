/**
 * The computer's direct-link listener (docs/direct-link.md): bearer capabilities in
 * the connection params, never in a URL; closed when they end; flood limits per
 * client address; a plain-HTTP health probe; the advertised address.
 */
import { createHash } from 'node:crypto'
import { createTRPCClient, createWSClient, wsLink, type TRPCClient } from '@trpc/client'
import type { DirectRouter } from '@slayzone/transport/direct'
import { wireSuperjson } from '@slayzone/trpc-server/wire'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createDirectGrantStore, type DirectGrantStore } from './grants'
import { advertisedDirectAddress, createDirectListener, type DirectListener } from './listener'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')
let n = 0
function grant(store: DirectGrantStore, over: { ttlMs?: number; sessionId?: string } = {}) {
  const token = `tok-${++n}-${'x'.repeat(40)}`
  store.grant('hub', {
    grantId: `g${n}`,
    tokenHash: hashOf(token),
    userId: 'u1',
    resource: { kind: 'pty', sessionId: over.sessionId ?? 's1' },
    ttlMs: over.ttlMs ?? 60_000
  })
  return { token, grantId: `g${n}` }
}

const logged: string[] = []
async function setup(limits?: Parameters<typeof createDirectListener>[0]['limits']) {
  const store = createDirectGrantStore()
  const audit: Array<Record<string, unknown>> = []
  const listener = await createDirectListener({
    grants: store,
    listenAddress: '127.0.0.1:0',
    log: (message, detail) => logged.push(JSON.stringify({ message, detail })),
    audit: (line) => audit.push({ ...line }),
    ...(limits ? { limits } : {})
  })
  cleanups.push(() => listener.close())
  cleanups.push(() => store.close())
  return { store, listener, audit }
}

function client(listener: DirectListener, token: string | null) {
  const closes: Array<{ code: number; reason: string }> = []
  const ws = createWSClient({
    url: `ws://${listener.boundAddress}/direct/v1`,
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    connectionParams: token === null ? null : { token },
    retryDelayMs: () => 60_000,
    onClose: (cause) => closes.push({ code: cause?.code ?? 0, reason: '' })
  })
  cleanups.push(() => ws.close())
  const trpc: TRPCClient<DirectRouter> = createTRPCClient<DirectRouter>({
    links: [wsLink({ client: ws, transformer: wireSuperjson })]
  })
  return { trpc, closes }
}

const waitFor = async (cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('direct listener: authentication', () => {
  it('serves a socket whose connection params carry a live capability', async () => {
    const { store, listener } = await setup()
    const { token } = grant(store)
    const { trpc } = client(listener, token)
    expect(await trpc.ping.query()).toEqual({ protocol: 1 })
  })

  it('closes a socket with no capability, or an unknown one', async () => {
    const { listener } = await setup()
    for (const token of [null, 'nope'.repeat(12)]) {
      const { trpc, closes } = client(listener, token)
      await expect(trpc.ping.query()).rejects.toThrow()
      await waitFor(() => closes.some((c) => c.code === 4401))
    }
  })

  it('adds and renews capabilities on an open socket', async () => {
    const { store, listener } = await setup()
    const first = grant(store)
    const second = grant(store, { sessionId: 's2' })
    const { trpc } = client(listener, first.token)
    expect(await trpc.authorize.mutate({ token: second.token })).toMatchObject({
      grantId: second.grantId,
      resource: { kind: 'pty', sessionId: 's2' }
    })
    await expect(trpc.authorize.mutate({ token: 'bogus'.repeat(10) })).rejects.toThrow(
      /unknown or expired/
    )
  })

  it('closes the socket once its last capability is revoked or expires', async () => {
    const { store, listener } = await setup()
    const a = grant(store)
    const b = grant(store, { sessionId: 's2' })
    const { trpc, closes } = client(listener, a.token)
    await trpc.authorize.mutate({ token: b.token })
    store.revoke('hub', { by: 'grant', grantIds: [a.grantId] })
    expect(await trpc.ping.query()).toEqual({ protocol: 1 })
    store.revoke('hub', { by: 'grant', grantIds: [b.grantId] })
    await waitFor(() => closes.some((c) => c.code === 4401))
  })
})

describe('direct listener: health and paths', () => {
  it('answers the plain-HTTP probe and refuses other paths', async () => {
    const { listener } = await setup()
    const health = await fetch(`http://${listener.boundAddress}/direct/v1/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ protocol: 1 })
    expect((await fetch(`http://${listener.boundAddress}/`)).status).toBe(404)
    const wrong = new WebSocket(`ws://${listener.boundAddress}/elsewhere`)
    await new Promise<void>((resolve) => wrong.once('error', () => resolve()))
  })
})

describe('direct listener: flood limits', () => {
  it('refuses upgrades past the per-address rate, and audits it once', async () => {
    const { store, listener, audit } = await setup({ upgradesPerMinute: 2 })
    const { token } = grant(store)
    for (let i = 0; i < 2; i++) expect(await client(listener, token).trpc.ping.query()).toBeTruthy()
    const refused = new WebSocket(`ws://${listener.boundAddress}/direct/v1`)
    const status = await new Promise<number>((resolve) =>
      refused.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    )
    expect(status).toBe(429)
    expect(audit).toEqual([
      expect.objectContaining({ limit: 'computer.direct.upgrades_per_address', max: 2 })
    ])
  })

  it('refuses upgrades from an address after too many failed authentications', async () => {
    const { listener, audit } = await setup({ failedAuthsPerMinute: 2 })
    for (let i = 0; i < 2; i++) {
      const { trpc, closes } = client(listener, 'bad'.repeat(15))
      await expect(trpc.ping.query()).rejects.toThrow()
      await waitFor(() => closes.length > 0)
    }
    const refused = new WebSocket(`ws://${listener.boundAddress}/direct/v1`)
    const status = await new Promise<number>((resolve) =>
      refused.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    )
    expect(status).toBe(429)
    expect(audit.some((a) => a.limit === 'computer.direct.failed_auth_per_address')).toBe(true)
  })

  it('caps open sockets per address', async () => {
    const { store, listener } = await setup({ socketsPerAddress: 1 })
    const { token } = grant(store)
    expect(await client(listener, token).trpc.ping.query()).toBeTruthy()
    const refused = new WebSocket(`ws://${listener.boundAddress}/direct/v1`)
    const status = await new Promise<number>((resolve) =>
      refused.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    )
    expect(status).toBe(429)
  })

  it('closes a socket that floods messages', async () => {
    const { store, listener } = await setup({ messagesPerSocketPer10s: 5 })
    const { token } = grant(store)
    // Raw frames: counted before tRPC parses anything (the tRPC client batches).
    // `?connectionParams=1` is how a tRPC client says its first frame carries them.
    const raw = new WebSocket(`ws://${listener.boundAddress}/direct/v1?connectionParams=1`)
    await new Promise<void>((resolve) => raw.once('open', () => resolve()))
    const code = new Promise<number>((resolve) => raw.once('close', (c) => resolve(c)))
    raw.send(JSON.stringify({ method: 'connectionParams', data: { token } }))
    for (let i = 0; i < 20; i++)
      raw.send(JSON.stringify({ id: i + 1, method: 'query', params: { path: 'ping' } }))
    expect(await code).toBe(1008)
  })
})

describe('advertisedDirectAddress', () => {
  it('advertises the public address when set, else a loopback bind, else nothing', () => {
    expect(advertisedDirectAddress('127.0.0.1:5000', 'box.example')).toBe('box.example')
    expect(advertisedDirectAddress('127.0.0.1:5000', undefined)).toBe('127.0.0.1:5000')
    expect(advertisedDirectAddress('[::1]:5000', undefined)).toBe('[::1]:5000')
    // A wildcard bind is not an address anyone can dial; the operator names one.
    expect(advertisedDirectAddress('0.0.0.0:7443', undefined)).toBeNull()
    expect(advertisedDirectAddress(null, 'box.example')).toBeNull()
  })
})

describe('direct listener: secrecy', () => {
  it('never logs or audits a token or its hash, valid or not', async () => {
    const { store, listener, audit } = await setup({ failedAuthsPerMinute: 1 })
    const good = grant(store)
    await client(listener, good.token).trpc.ping.query()
    const bad = 'leak'.repeat(12)
    const { trpc, closes } = client(listener, bad)
    await expect(trpc.ping.query()).rejects.toThrow()
    await waitFor(() => closes.length > 0)
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://${listener.boundAddress}/direct/v1`)
      ws.once('unexpected-response', () => resolve())
      ws.once('error', () => resolve())
    })
    const everything = JSON.stringify([logged, audit])
    for (const secret of [good.token, hashOf(good.token), bad, hashOf(bad)]) {
      expect(everything).not.toContain(secret)
    }
    expect(audit.length).toBeGreaterThan(0)
  })
})
