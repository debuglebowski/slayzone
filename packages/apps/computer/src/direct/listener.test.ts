/**
 * The computer's direct-link listener (docs/direct-link.md): bearer capabilities in
 * the connection params, never in a URL; closed when they end; flood limits per
 * client address; a plain-HTTP health probe; the advertised address.
 */
import { createHash } from 'node:crypto'
import { createTRPCClient, createWSClient, wsLink, type TRPCClient } from '@trpc/client'
import { createDirectRouter, type DirectRouter } from '@slayzone/transport/direct'
import { wireSuperjson } from '@slayzone/trpc-server/wire'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { channelWebSocket } from '../../../../shared/transport/src/direct/rtc-channel'
import { fakeChannelPair } from '../../../../shared/transport/src/direct/rtc-channel-fake'
import { createDirectGrantStore, type DirectGrantStore } from './grants'
import { RtcServerSocket } from './rtc-socket'
import { advertisedDirectAddress, createDirectListener, type DirectListener } from './listener'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')
let n = 0
function grant(
  store: DirectGrantStore,
  over: { ttlMs?: number; sessionId?: string; chat?: { tabId: string; epoch: number } } = {}
) {
  const token = `tok-${++n}-${'x'.repeat(40)}`
  store.grant('hub', {
    grantId: `g${n}`,
    tokenHash: hashOf(token),
    userId: 'u1',
    resource: over.chat
      ? { kind: 'chat', ...over.chat }
      : { kind: 'pty', sessionId: over.sessionId ?? 's1' },
    ttlMs: over.ttlMs ?? 60_000
  })
  return { token, grantId: `g${n}` }
}

const logged: string[] = []

/** A stand-in for one hub's terminals: session `s1` and `s2`, live. */
function fakePty() {
  const watchers = new Map<
    string,
    { onData: (c: { seq: number; data: string }) => void; onEnd: (r: 'exit') => void }
  >()
  const service = {
    attach: (sessionId: string, afterSeq: number) => ({
      exists: true,
      size: { cols: 80, rows: 24 },
      buffer: { chunks: [{ seq: 0, data: `${sessionId}-0` }], prelude: '', currentSeq: 0, afterSeq }
    }),
    writes: [] as Array<[string, string]>,
    write(sessionId: string, data: string) {
      this.writes.push([sessionId, data])
      return sessionId === 's1'
    },
    getBufferSince: (sessionId: string) => ({
      chunks: [{ seq: 0, data: `${sessionId}-0` }],
      prelude: '',
      currentSeq: 0
    }),
    watch: (
      sessionId: string,
      onData: (c: { seq: number; data: string }) => void,
      onEnd: (r: 'exit') => void
    ) => {
      watchers.set(sessionId, { onData, onEnd })
      return () => watchers.delete(sessionId)
    }
  }
  return { service, watchers }
}

/** A stand-in for one hub's chat. */
function fakeChat() {
  const reads: unknown[] = []
  const commands: unknown[] = []
  const watchers = new Map<
    string,
    { onEvent: (e: unknown) => void; onEnd: (r: 'epoch') => void; epoch: number }
  >()
  const service = {
    read: async (tabId: string, epoch: number, method: string, args: unknown[]) => {
      reads.push({ tabId, epoch, method, args })
      return { ok: method }
    },
    command: async (
      tabId: string,
      epoch: number,
      method: string,
      args: unknown[],
      operationId: string
    ) => {
      commands.push({ tabId, epoch, method, args, operationId })
      return { ok: method }
    },
    watch: (
      tabId: string,
      epoch: number,
      onEvent: (e: { tabId: string; event: unknown; seq: number }) => void,
      onEnd: (r: 'epoch') => void
    ) => {
      watchers.set(tabId, { onEvent: onEvent as (e: unknown) => void, onEnd, epoch })
      return () => watchers.delete(tabId)
    }
  }
  return { service, reads, commands, watchers }
}

async function setup(limits?: Parameters<typeof createDirectListener>[0]['limits']) {
  const pty = fakePty()
  const chat = fakeChat()
  const store = createDirectGrantStore()
  const audit: Array<Record<string, unknown>> = []
  const listener = await createDirectListener({
    grants: store,
    listenAddress: '127.0.0.1:0',
    log: (message, detail) => logged.push(JSON.stringify({ message, detail })),
    audit: (line) => audit.push({ ...line }),
    services: {
      pty: (hubKey) => (hubKey === 'hub' ? pty.service : null),
      chat: (hubKey) => (hubKey === 'hub' ? chat.service : null)
    },
    ...(limits ? { limits } : {})
  })
  cleanups.push(() => listener.close())
  cleanups.push(() => store.close())
  return { store, listener, audit, pty, chat }
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
    const { store, listener } = await setup({ messagesPerGrantPer10s: 5 })
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

describe('direct listener: message budget scales with what the socket carries', () => {
  // All of a computer's terminals share one socket: heavy mouse reporting in several
  // TUIs must not trip a limit sized for one.
  it('a socket holding more grants may send more, up to the per-socket ceiling', async () => {
    const { store, listener } = await setup({
      messagesPerGrantPer10s: 5,
      messagesPerSocketPer10s: 100
    })
    // Three distinct targets (a newer grant on the same target supersedes the older).
    const tokens = [
      grant(store),
      grant(store, { sessionId: 's2' }),
      grant(store, { chat: { tabId: 't1', epoch: 1 } })
    ].map((g) => g.token)
    const raw = new WebSocket(`ws://${listener.boundAddress}/direct/v1?connectionParams=1`)
    await new Promise<void>((resolve) => raw.once('open', () => resolve()))
    let closed: number | null = null
    raw.once('close', (c) => {
      closed = c
    })
    raw.send(JSON.stringify({ method: 'connectionParams', data: { token: tokens[0] } }))
    for (const [i, token] of tokens.slice(1).entries())
      raw.send(
        JSON.stringify({
          id: 100 + i,
          method: 'mutation',
          params: { path: 'authorize', input: { json: { token } } }
        })
      )
    await new Promise((r) => setTimeout(r, 200))
    // 3 grants: 15 messages per window; 3 sent so far, 10 more stay inside it.
    for (let i = 0; i < 10; i++)
      raw.send(JSON.stringify({ id: i + 1, method: 'query', params: { path: 'ping' } }))
    await new Promise((r) => setTimeout(r, 200))
    expect(closed).toBeNull()
    for (let i = 0; i < 10; i++)
      raw.send(JSON.stringify({ id: i + 50, method: 'query', params: { path: 'ping' } }))
    await new Promise((r) => setTimeout(r, 200))
    expect(closed).toBe(1008)
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

describe('direct listener: terminals', () => {
  it('serves attach, backfill and the live stream for the granted session', async () => {
    const { store, listener, pty } = await setup()
    const { token } = grant(store)
    const { trpc } = client(listener, token)
    expect(await trpc.pty.attach.query({ sessionId: 's1', afterSeq: -1 })).toMatchObject({
      exists: true,
      size: { cols: 80, rows: 24 },
      buffer: { currentSeq: 0, chunks: [{ seq: 0, data: 's1-0' }] }
    })
    expect(await trpc.pty.getBufferSince.query({ sessionId: 's1', afterSeq: -1 })).toMatchObject({
      currentSeq: 0
    })
    const got: unknown[] = []
    let completed = false
    const sub = trpc.pty.onData.subscribe(
      { sessionId: 's1' },
      { onData: (d) => got.push(d), onComplete: () => (completed = true) }
    )
    await waitFor(() => pty.watchers.has('s1'))
    pty.watchers.get('s1')?.onData({ seq: 1, data: 'hi' })
    await waitFor(() => got.length === 1)
    expect(got).toEqual([{ sessionId: 's1', seq: 1, data: 'hi' }])
    pty.watchers.get('s1')?.onEnd('exit')
    await waitFor(() => completed)
    sub.unsubscribe()
  })

  it('refuses a session the socket holds no grant for', async () => {
    const { store, listener } = await setup()
    const { token } = grant(store, { sessionId: 's1' })
    const { trpc } = client(listener, token)
    await expect(trpc.pty.attach.query({ sessionId: 's2', afterSeq: -1 })).rejects.toThrow(
      /no capability/
    )
    await expect(trpc.pty.getBufferSince.query({ sessionId: 's2', afterSeq: 0 })).rejects.toThrow(
      /no capability/
    )
    const errors: unknown[] = []
    trpc.pty.onData.subscribe({ sessionId: 's2' }, { onError: (e) => errors.push(e) })
    await waitFor(() => errors.length === 1)
  })

  it('ends the stream when that session’s grant is revoked, keeping the socket', async () => {
    const { store, listener, pty } = await setup()
    const a = grant(store, { sessionId: 's1' })
    const b = grant(store, { sessionId: 's2' })
    const { trpc, closes } = client(listener, a.token)
    await trpc.authorize.mutate({ token: b.token })
    const errors: unknown[] = []
    trpc.pty.onData.subscribe({ sessionId: 's1' }, { onError: (e) => errors.push(e) })
    await waitFor(() => pty.watchers.has('s1'))
    store.revoke('hub', { by: 'grant', grantIds: [a.grantId] })
    await waitFor(() => errors.length === 1)
    expect(pty.watchers.has('s1')).toBe(false)
    expect(await trpc.pty.attach.query({ sessionId: 's2', afterSeq: -1 })).toBeTruthy()
    expect(closes).toEqual([])
  })
})

describe('direct listener: terminal input', () => {
  it('writes to a granted session only', async () => {
    const { store, listener, pty } = await setup()
    const { token } = grant(store, { sessionId: 's1' })
    const { trpc } = client(listener, token)
    expect(await trpc.pty.write.mutate({ sessionId: 's1', data: 'ls\r' })).toBe(true)
    await expect(trpc.pty.write.mutate({ sessionId: 's2', data: 'rm -rf /\r' })).rejects.toThrow(
      /no capability/
    )
    expect(pty.service.writes).toEqual([['s1', 'ls\r']])
  })
})

describe('client manager against the real listener (computer restart)', () => {
  it('never reopens a socket to a computer that went away, and redials the new address', async () => {
    const { createDirectLinkManager } = await import('@slayzone/transport/direct-client')
    const RealWebSocket = globalThis.WebSocket
    let constructed = 0
    globalThis.WebSocket = class extends RealWebSocket {
      constructor(...args: ConstructorParameters<typeof RealWebSocket>) {
        super(...args)
        constructed++
      }
    } as typeof RealWebSocket
    try {
      const first = await setup()
      let current = first
      const manager = createDirectLinkManager({
        issue: async () => {
          const { token } = grant(current.store)
          return {
            available: true,
            computerId: 'c1',
            address: current.listener.boundAddress,
            token,
            grantId: 'g',
            expiresInMs: 60_000,
            protocol: 1
          }
        },
        backoffInitialMs: 50
      })
      cleanups.push(() => manager.dispose())
      const lease = await manager.acquire({ kind: 'pty', sessionId: 's1', taskId: 't' })
      expect(lease).not.toBeNull()
      const lost: string[] = []
      lease?.onLost((r) => lost.push(r))
      expect(constructed).toBe(1)
      // The computer restarts: its listener goes, a new one binds another port.
      await first.listener.close()
      await waitFor(() => lost.length === 1)
      expect(lost).toEqual(['closed'])
      await new Promise((r) => setTimeout(r, 300))
      // No blind reconnect to the dead port.
      expect(constructed).toBe(1)
      current = await setup()
      const again = await manager.acquire({ kind: 'pty', sessionId: 's1', taskId: 't' })
      expect(again).not.toBeNull()
      expect(constructed).toBe(2)
      expect(await again?.client.ping.query()).toEqual({ protocol: 1 })
    } finally {
      globalThis.WebSocket = RealWebSocket
    }
  })
})

describe('direct listener: chat', () => {
  it('reads under the granted epoch, only for the granted tab', async () => {
    const { store, listener, chat } = await setup()
    const { token } = grant(store, { chat: { tabId: 't1', epoch: 3 } })
    const { trpc } = client(listener, token)
    expect(await trpc.chat.getReplay.query({ tabId: 't1', afterSeq: -1 })).toEqual({
      ok: 'getReplay'
    })
    await trpc.chat.timelinePages.query({ tabId: 't1', pages: [0], asOfSeq: 9, epoch: 3 })
    expect(chat.reads).toEqual([
      { tabId: 't1', epoch: 3, method: 'getReplay', args: ['t1', -1] },
      { tabId: 't1', epoch: 3, method: 'timelinePages', args: ['t1', [0], 9, 3] }
    ])
    await expect(trpc.chat.getReplay.query({ tabId: 't2', afterSeq: -1 })).rejects.toThrow(
      /no capability/
    )
    // A pty grant does not reach chat.
    const p = grant(store, { sessionId: 't1' })
    await expect(
      client(listener, p.token).trpc.chat.getReplay.query({ tabId: 't1', afterSeq: -1 })
    ).rejects.toThrow(/no capability/)
  })

  it('streams the tab’s events and errors when the conversation moves (epoch)', async () => {
    const { store, listener, chat } = await setup()
    const { token } = grant(store, { chat: { tabId: 't1', epoch: 3 } })
    const { trpc } = client(listener, token)
    const got: unknown[] = []
    const errors: unknown[] = []
    trpc.chat.onEvent.subscribe(
      { tabId: 't1' },
      { onData: (e) => got.push(e), onError: (e) => errors.push(e) }
    )
    await waitFor(() => chat.watchers.has('t1'))
    expect(chat.watchers.get('t1')?.epoch).toBe(3)
    chat.watchers.get('t1')?.onEvent({ tabId: 't1', event: { kind: 'x' }, seq: 1, at: 5 })
    await waitFor(() => got.length === 1)
    expect(got).toEqual([{ tabId: 't1', event: { kind: 'x' }, seq: 1, at: 5 }])
    chat.watchers.get('t1')?.onEnd('epoch')
    await waitFor(() => errors.length === 1)
  })
})

// M4: a tab's epoch moves while its computer stays the same. The client authorizes a
// new-epoch grant on the same socket; it must win over the old one at once, and a
// renewal must replace (not pile up on) what the socket holds.
describe('direct listener: grant replacement and release', () => {
  it('the newest grant for a target wins; the one it supersedes leaves the socket', async () => {
    const { store, listener, chat } = await setup()
    const old = grant(store, { chat: { tabId: 't1', epoch: 1 } })
    const { trpc } = client(listener, old.token)
    await trpc.chat.getReplay.query({ tabId: 't1', afterSeq: -1 })
    const fresh = grant(store, { chat: { tabId: 't1', epoch: 2 } })
    const view = await trpc.authorize.mutate({ token: fresh.token })
    expect(view.grantId).toBe(fresh.grantId)
    await trpc.chat.getReplay.query({ tabId: 't1', afterSeq: -1 })
    expect(chat.reads.map((r) => (r as { epoch: number }).epoch)).toEqual([1, 2])
    // The superseded grant is gone from the socket: revoking it ends nothing.
    store.revoke('hub', { by: 'grant', grantIds: [old.grantId] })
    await trpc.chat.getReplay.query({ tabId: 't1', afterSeq: -1 })
    expect(chat.reads.length).toBe(3)
  })

  it('renewals never fill the per-socket cap', async () => {
    const { store, listener } = await setup({ grantsPerSocket: 3 })
    const first = grant(store, { sessionId: 's1' })
    const { trpc } = client(listener, first.token)
    for (let i = 0; i < 10; i++) {
      const next = grant(store, { sessionId: 's1' })
      expect((await trpc.authorize.mutate({ token: next.token })).grantId).toBe(next.grantId)
    }
    const other = grant(store, { sessionId: 's2' })
    expect((await trpc.authorize.mutate({ token: other.token })).grantId).toBe(other.grantId)
  })

  // R4: a release names the grant it held; a newer grant on the same target, which
  // another holder just authorised, survives it.
  it('releasing a superseded grant leaves the newer one on the target', async () => {
    const { store, listener } = await setup()
    const a = grant(store, { sessionId: 's1' })
    const { trpc } = client(listener, a.token)
    const b = grant(store, { sessionId: 's1' })
    await trpc.authorize.mutate({ token: b.token })
    expect(await trpc.release.mutate({ grantId: a.grantId })).toEqual({ released: false })
    expect((await trpc.pty.attach.query({ sessionId: 's1', afterSeq: -1 })).exists).toBe(true)
  })

  it('a released grant leaves the socket (the lease is gone)', async () => {
    const { store, listener } = await setup()
    const a = grant(store, { sessionId: 's1' })
    const { trpc } = client(listener, a.token)
    const b = grant(store, { sessionId: 's2' })
    await trpc.authorize.mutate({ token: b.token })
    expect(await trpc.release.mutate({ grantId: b.grantId })).toEqual({ released: true })
    await expect(trpc.pty.attach.query({ sessionId: 's2', afterSeq: -1 })).rejects.toThrow(
      /no capability/
    )
    expect((await trpc.pty.attach.query({ sessionId: 's1', afterSeq: -1 })).exists).toBe(true)
  })
})

describe('direct listener: chat commands', () => {
  it('runs the simple commands under the granted epoch, with an operation id', async () => {
    const { store, listener, chat } = await setup()
    const { token } = grant(store, { chat: { tabId: 't1', epoch: 3 } })
    const { trpc } = client(listener, token)
    // Permission and tool answers are no direct commands: the hub's relay refuses
    // them while the conversation runs in the terminal.
    const procedures = Object.keys(
      (
        createDirectRouter({ pty: () => null, chat: () => null }) as unknown as {
          _def: { procedures: Record<string, unknown> }
        }
      )._def.procedures
    )
    expect(procedures).not.toContain('chat.respondPermission')
    expect(procedures).not.toContain('chat.sendToolResult')
    expect(procedures).toContain('chat.saveScroll')
    await trpc.chat.saveScroll.mutate({
      tabId: 't1',
      anchor: { atBottom: true },
      operationId: 'op-1'
    })
    await trpc.chat.saveDraft.mutate({
      tabId: 't1',
      draft: { text: 'hi', attachments: [] },
      expectedMode: 'claude-chat'
    })
    expect(chat.commands).toEqual([
      {
        tabId: 't1',
        epoch: 3,
        method: 'saveTabScroll',
        args: ['t1', { atBottom: true }],
        operationId: 'op-1'
      },
      {
        tabId: 't1',
        epoch: 3,
        method: 'saveTabDraft',
        args: [
          't1',
          { text: 'hi', attachments: [] },
          { expectedMode: 'claude-chat', expectedOwnership: undefined }
        ],
        operationId: expect.any(String)
      }
    ])
  })

  it('refuses a draft with attachments (the hub seals files) and an ungranted tab', async () => {
    const { store, listener, chat } = await setup()
    const { token } = grant(store, { chat: { tabId: 't1', epoch: 3 } })
    const { trpc } = client(listener, token)
    await expect(
      trpc.chat.saveDraft.mutate({
        tabId: 't1',
        draft: { text: 'x', attachments: [{ artifactId: 'a' } as never] }
      })
    ).rejects.toThrow()
    await expect(
      trpc.chat.saveScroll.mutate({ tabId: 't2', anchor: { atBottom: true } })
    ).rejects.toThrow(/no capability/)
    expect(chat.commands).toEqual([])
  })
})

// M5: a WebRTC data channel is served exactly like a WebSocket — same capability
// auth, grants, flood limits and per-address caps (docs/direct-link.md).
describe('direct listener: data channels', () => {
  function rtcClient(listener: DirectListener, token: string | null, ip = '198.51.100.7') {
    const [mine, theirs] = fakeChannelPair()
    const socket = new RtcServerSocket(theirs, { maxMessageChars: 1 << 20 })
    const served = listener.serveChannel(socket, { ip })
    mine.open()
    theirs.open()
    const closes: number[] = []
    const ws = createWSClient({
      url: 'rtc://direct',
      WebSocket: channelWebSocket(mine, { maxMessageChars: 1 << 20 }) as never,
      connectionParams: token === null ? null : { token },
      retryDelayMs: () => 60_000,
      onClose: (cause) => closes.push(cause?.code ?? 0)
    })
    cleanups.push(() => ws.close())
    const trpc: TRPCClient<DirectRouter> = createTRPCClient<DirectRouter>({
      links: [wsLink({ client: ws, transformer: wireSuperjson })]
    })
    return { trpc, served, socket, closes }
  }

  it('serves a channel whose first frame carries a live capability: same router, same grants', async () => {
    const { store, listener } = await setup()
    const { token } = grant(store, { sessionId: 's1' })
    const { trpc, served } = rtcClient(listener, token)
    expect(served).toBe(true)
    expect(await trpc.ping.query()).toEqual({ protocol: 1 })
    expect((await trpc.pty.attach.query({ sessionId: 's1', afterSeq: -1 })).exists).toBe(true)
    await expect(trpc.pty.attach.query({ sessionId: 's2', afterSeq: -1 })).rejects.toThrow(
      /no capability/
    )
  })

  it('closes a channel with no capability, or an unknown one', async () => {
    const { listener } = await setup()
    for (const token of [null, 'nope'.repeat(12)]) {
      const { trpc, socket } = rtcClient(listener, token)
      await expect(trpc.ping.query()).rejects.toThrow()
      await waitFor(() => socket.readyState === 3)
    }
  })

  it('counts channels against the per-address caps, and refuses past them', async () => {
    const { store, listener, audit } = await setup({ socketsPerAddress: 2 })
    const { token } = grant(store)
    expect(rtcClient(listener, token).served).toBe(true)
    expect(rtcClient(listener, token).served).toBe(true)
    const third = rtcClient(listener, token)
    expect(third.served).toBe(false)
    expect(third.socket.readyState).toBe(3)
    expect(audit.some((a) => a.limit === 'computer.direct.sockets_per_address')).toBe(true)
    // Another address is not affected.
    expect(rtcClient(listener, token, '203.0.113.5').served).toBe(true)
  })

  it('ends the channel when its last capability is revoked', async () => {
    const { store, listener } = await setup()
    const a = grant(store)
    const { trpc, socket } = rtcClient(listener, a.token)
    expect(await trpc.ping.query()).toEqual({ protocol: 1 })
    store.revoke('hub', { by: 'grant', grantIds: [a.grantId] })
    await waitFor(() => socket.readyState === 3)
  })
})
