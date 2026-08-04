/**
 * Loopback tests: a real in-process `ws` server wired to the hub gateway,
 * exercised by the real runner dialer — no app, no network beyond 127.0.0.1.
 */
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryCredentialStore } from '../client/credential-store'
import { HubDialer, type HubDialerOptions } from '../client/hub-dialer'
import { RunnerTransportErrorCodes } from '../shared/frames'
import { JSON_RPC_INTERNAL_ERROR, RpcError, RpcTimeoutError } from '../shared/rpc'
import { startLoopbackHub, type LoopbackHub } from '../testing/loopback'

const IDENTITY = { name: 'test-runner', platform: 'darwin-arm64', version: '0.0.0', capabilities: ['pty'] }

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.useRealTimers()
})

function makeDialer(url: string, overrides: Partial<HubDialerOptions> = {}): HubDialer {
  const dialer = new HubDialer({
    url,
    identity: IDENTITY,
    credentialStore: createMemoryCredentialStore(),
    joinToken: 'jt-valid',
    heartbeatIntervalMs: 0, // most tests drive liveness explicitly
    backoff: { initialDelayMs: 10, maxDelayMs: 50, multiplier: 2, jitterRatio: 0 },
    ...overrides
  })
  cleanups.push(() => dialer.stop())
  return dialer
}

async function startHub(...args: Parameters<typeof startLoopbackHub>): Promise<LoopbackHub> {
  const hub = await startLoopbackHub(...args)
  cleanups.push(() => hub.close())
  return hub
}

describe('enrollment', () => {
  it('happy path: enroll mints credentials, registers the runner, persists creds', async () => {
    const hub = await startHub()
    const store = createMemoryCredentialStore()
    const enrolled = hub.gateway.events.once('runner-enrolled')
    const dialer = makeDialer(hub.url, { credentialStore: store })
    dialer.start()

    const connected = await dialer.events.once('connected')
    expect(connected.mode).toBe('enroll')
    expect(connected.runnerId).toBe('runner-1')
    expect(dialer.runnerId).toBe('runner-1')
    expect(dialer.state).toBe('connected')

    const { runner } = await enrolled
    expect(runner).toMatchObject({
      runnerId: 'runner-1',
      name: 'test-runner',
      platform: 'darwin-arm64',
      version: '0.0.0',
      capabilities: ['pty'],
      authMode: 'enroll'
    })
    expect(hub.gateway.listRunners().map((r) => r.runnerId)).toEqual(['runner-1'])

    const saved = await store.load()
    expect(saved?.runnerId).toBe('runner-1')
    expect(saved?.apiKey).toMatch(/^key-/)
    expect(hub.auth.byApiKey.has(saved!.apiKey)).toBe(true)
  })

  it('bad join token: enrollment is refused with unauthorized and the dialer gives up (fatal)', async () => {
    const hub = await startHub()
    const dialer = makeDialer(hub.url, { joinToken: 'jt-WRONG' })
    const errorEvent = dialer.events.once('error')
    dialer.start()

    const { error, fatal, reason } = await errorEvent
    expect(fatal).toBe(true)
    // Assert the machine-readable reason, not the prose: an operator-facing message
    // should be free to change without breaking a test.
    expect(reason).toBe('needs-re-enrollment')
    expect(error.message).toContain('bad join token')

    await dialer.events.once('disconnected')
    expect(dialer.state).toBe('stopped')
    expect(hub.gateway.listRunners()).toEqual([])
  })

  it('protocol version mismatch is refused with protocolMismatch', async () => {
    const hub = await startHub()
    const ws = new WebSocket(hub.url)
    cleanups.push(() => ws.terminate())
    await new Promise<void>((resolve) => ws.once('open', () => resolve()))
    const reply = new Promise<Record<string, unknown>>((resolve) =>
      ws.once('message', (data) => resolve(JSON.parse(data.toString())))
    )
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'enroll',
        params: { joinToken: 'jt-valid', name: 'n', platform: 'p', version: 'v', capabilities: [], protocolVersion: 99 }
      })
    )
    const frame = await reply
    expect((frame.error as { code: number }).code).toBe(RunnerTransportErrorCodes.protocolMismatch)
  })
})

describe('reconnect auth (hello)', () => {
  it('a dialer with stored credentials reconnects via hello', async () => {
    const hub = await startHub()
    const store = createMemoryCredentialStore()
    const first = makeDialer(hub.url, { credentialStore: store })
    first.start()
    await first.events.once('connected')
    const disconnected = hub.gateway.events.once('runner-disconnected')
    await first.stop()
    await disconnected
    expect(hub.gateway.listRunners()).toEqual([])

    const second = makeDialer(hub.url, { credentialStore: store })
    const reconnected = hub.gateway.events.once('runner-connected')
    second.start()
    const connected = await second.events.once('connected')
    expect(connected.mode).toBe('hello')
    expect(connected.runnerId).toBe('runner-1')
    expect((await reconnected).runner.authMode).toBe('hello')
    expect(hub.auth.enrollCalls).toHaveLength(1) // no re-enroll
  })

  it('carries the runner process epoch through both enroll and hello', async () => {
    // The epoch is what lets the hub tell "my socket dropped" from "the runner
    // died" — a reconnect reporting the SAME one proves the process holding the
    // pty sessions never went away, so they can be reattached instead of being
    // declared dead. It has to survive the hello path too: that is the one a
    // reconnect actually uses.
    const hub = await startHub()
    const store = createMemoryCredentialStore()
    const enrolled = hub.gateway.events.once('runner-connected')
    const first = makeDialer(hub.url, { credentialStore: store, epoch: 'epoch-xyz' })
    first.start()
    await first.events.once('connected')
    expect((await enrolled).runner).toMatchObject({ authMode: 'enroll', epoch: 'epoch-xyz' })

    const disconnected = hub.gateway.events.once('runner-disconnected')
    await first.stop()
    await disconnected

    const rejoined = hub.gateway.events.once('runner-connected')
    const second = makeDialer(hub.url, { credentialStore: store, epoch: 'epoch-xyz' })
    second.start()
    await second.events.once('connected')
    expect((await rejoined).runner).toMatchObject({ authMode: 'hello', epoch: 'epoch-xyz' })
  })

  it('stale api key falls back to enroll when a join token is present', async () => {
    const hub = await startHub()
    const store = createMemoryCredentialStore({ runnerId: 'runner-old', apiKey: 'key-revoked' })
    const dialer = makeDialer(hub.url, { credentialStore: store })
    dialer.start()
    const connected = await dialer.events.once('connected')
    expect(connected.mode).toBe('enroll')
    expect(hub.auth.helloCalls).toEqual(['key-revoked'])
    expect((await store.load())?.runnerId).toBe('runner-1')
  })
})

describe('hub → runner requests', () => {
  it('exec commands round-trip and correlate out-of-order responses', async () => {
    const hub = await startHub()
    const resolvers = new Map<string, (v: unknown) => void>()
    const dialer = makeDialer(hub.url, {
      onHubRequest: (method, params) => {
        if (method === 'pty.kill') {
          const { sessionId } = params as { sessionId: string }
          return new Promise((resolve) => resolvers.set(sessionId, resolve))
        }
        throw new RpcError(RunnerTransportErrorCodes.unimplemented, `unimplemented: ${method}`)
      }
    })
    dialer.start()
    await dialer.events.once('connected')

    const a = hub.gateway.request('runner-1', 'pty.kill', { sessionId: 'a' })
    const b = hub.gateway.request('runner-1', 'pty.kill', { sessionId: 'b' })
    await vi.waitFor(() => expect(resolvers.size).toBe(2))
    resolvers.get('b')!({ killed: 'b' })
    resolvers.get('a')!({ killed: 'a' })
    await expect(b).resolves.toEqual({ killed: 'b' })
    await expect(a).resolves.toEqual({ killed: 'a' })

    // RpcError from the handler propagates code + message to the hub side.
    const err = await hub.gateway.request('runner-1', 'pty.spawn', { sessionId: 's' }).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).code).toBe(RunnerTransportErrorCodes.unimplemented)
  })

  it('requests time out when the runner never answers', async () => {
    const hub = await startHub()
    const dialer = makeDialer(hub.url, {
      onHubRequest: () => new Promise(() => {}) // never resolves
    })
    dialer.start()
    await dialer.events.once('connected')

    const err = await hub.gateway.request('runner-1', 'pty.resize', { sessionId: 's', cols: 80, rows: 24 }, 50).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(RpcTimeoutError)
  })

  it('requests to unknown runners reject with unknownRunner', async () => {
    const hub = await startHub()
    const err = await hub.gateway.request('runner-nope', 'ping').then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).code).toBe(RunnerTransportErrorCodes.unknownRunner)
  })

  it('ping is answered by the dialer without an onHubRequest handler', async () => {
    const hub = await startHub()
    const dialer = makeDialer(hub.url, { onHubRequest: undefined })
    dialer.start()
    await dialer.events.once('connected')
    const pong = await hub.gateway.request<{ ts: number }>('runner-1', 'ping', { ts: 1 })
    expect(typeof pong.ts).toBe('number')
    // …and every exec command is -32001 unimplemented by default.
    const err = await hub.gateway.request('runner-1', 'fs.readFile', { path: '/x' }).then(
      () => null,
      (e: unknown) => e
    )
    expect((err as RpcError).code).toBe(RunnerTransportErrorCodes.unimplemented)
  })
})

describe('runner → hub notifications', () => {
  it('pty.data seq is preserved end-to-end and in order', async () => {
    const hub = await startHub()
    const dialer = makeDialer(hub.url)
    dialer.start()
    await dialer.events.once('connected')

    const received: Array<{ runnerId: string; sessionId: string; seq: number; data: string }> = []
    hub.gateway.events.on('pty.data', (payload) => received.push(payload))
    for (const seq of [1, 2, 3]) {
      expect(dialer.notify('pty.data', { sessionId: 'sess-1', seq, data: `chunk-${seq}` })).toBe(true)
    }
    await vi.waitFor(() => expect(received).toHaveLength(3))
    expect(received.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(received[0]).toEqual({ runnerId: 'runner-1', sessionId: 'sess-1', seq: 1, data: 'chunk-1' })

    const exit = hub.gateway.events.once('pty.exit')
    dialer.notify('pty.exit', { sessionId: 'sess-1', exitCode: 0 })
    expect(await exit).toMatchObject({ runnerId: 'runner-1', sessionId: 'sess-1', exitCode: 0 })
  })
})

describe('malformed frames', () => {
  it('garbage from a socket surfaces as protocol-error and never crashes the gateway', async () => {
    const hub = await startHub()
    const protocolErrors: Array<{ detail: string }> = []
    hub.gateway.events.on('protocol-error', (e) => protocolErrors.push(e))

    const raw = new WebSocket(hub.url)
    cleanups.push(() => raw.terminate())
    await new Promise<void>((resolve) => raw.once('open', () => resolve()))
    raw.send('garbage{')
    raw.send(JSON.stringify([1, 2, 3]))
    raw.send(JSON.stringify({ jsonrpc: '2.0' })) // no method, no id
    raw.send(JSON.stringify({ jsonrpc: '2.0', method: 'pty.data', params: { sessionId: 's', seq: 1, data: 'x' } })) // pre-auth notification
    await vi.waitFor(() => expect(protocolErrors.length).toBeGreaterThanOrEqual(4))

    // Gateway still fully functional afterwards.
    const dialer = makeDialer(hub.url)
    dialer.start()
    await dialer.events.once('connected')
    expect(hub.gateway.listRunners()).toHaveLength(1)
  })

  it('pre-auth requests other than enroll/hello are refused with unauthorized', async () => {
    const hub = await startHub()
    const raw = new WebSocket(hub.url)
    cleanups.push(() => raw.terminate())
    await new Promise<void>((resolve) => raw.once('open', () => resolve()))
    const reply = new Promise<Record<string, unknown>>((resolve) =>
      raw.once('message', (data) => resolve(JSON.parse(data.toString())))
    )
    raw.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'heartbeat', params: {} }))
    expect(((await reply).error as { code: number }).code).toBe(RunnerTransportErrorCodes.unauthorized)
  })

  it('malformed pty.data notifications are dropped with protocol-error, valid ones still flow', async () => {
    const hub = await startHub()
    const dialer = makeDialer(hub.url)
    dialer.start()
    await dialer.events.once('connected')

    const protocolError = hub.gateway.events.once('protocol-error')
    dialer.notify('pty.data', { sessionId: 'x', seq: 'NaN-ish', data: 5 }) // wrong types
    expect((await protocolError).detail).toContain('pty.data')

    const ok = hub.gateway.events.once('pty.data')
    dialer.notify('pty.data', { sessionId: 'x', seq: 1, data: 'fine' })
    expect((await ok).seq).toBe(1)
  })
})

describe('heartbeat-loss detection (hub side)', () => {
  it('a silent runner is terminated and reported as runner-lost', async () => {
    vi.useFakeTimers()
    const hub = await startHub({ heartbeatTimeoutMs: 5_000 })
    const dialer = makeDialer(hub.url, { heartbeatIntervalMs: 0 }) // never heartbeats
    dialer.start()
    await dialer.events.once('connected')
    expect(hub.gateway.listRunners()).toHaveLength(1)

    const lost = hub.gateway.events.once('runner-lost')
    const disconnected = hub.gateway.events.once('runner-disconnected')
    await vi.advanceTimersByTimeAsync(5_001)
    expect(await lost).toEqual({ runnerId: 'runner-1', reason: 'heartbeat-timeout' })
    expect((await disconnected).reason).toBe('heartbeat-timeout')
    expect(hub.gateway.listRunners()).toEqual([])
  })

  it('a frozen process (host sleep) re-arms the watchdog instead of declaring the runner lost', async () => {
    // Closing the laptop lid froze both processes. On wake the watchdog fired
    // with a wall-clock delta of however long the machine slept, read that as
    // "silent past the window", and disposed every terminal session on the
    // runner as exitCode 1 — while the runner and its agents were still alive.
    vi.useFakeTimers()
    const hub = await startHub({ heartbeatTimeoutMs: 5_000 })
    const dialer = makeDialer(hub.url, { heartbeatIntervalMs: 0 }) // never heartbeats
    let lost = false
    hub.gateway.events.on('runner-lost', () => {
      lost = true
    })
    dialer.start()
    await dialer.events.once('connected')

    // Host asleep for 20 minutes: the wall clock jumps, but the watchdog's timer
    // only ever counted its own 5s delay. `setSystemTime` moves Date.now()
    // WITHOUT the timer clock, which is exactly what a frozen process observes.
    vi.setSystemTime(Date.now() + 20 * 60_000)
    await vi.advanceTimersByTimeAsync(5_001)

    expect(lost).toBe(false)
    expect(hub.gateway.listRunners()).toHaveLength(1)

    // The guard buys exactly ONE fresh window — it defers the decision, it does
    // not disable it. A runner that is still silent afterwards is reaped.
    await vi.advanceTimersByTimeAsync(5_001)
    expect(lost).toBe(true)
    expect(hub.gateway.listRunners()).toEqual([])
  })

  it('heartbeats keep the runner alive past the watchdog window', async () => {
    // Real timers: heartbeat round-trips are I/O, which a fake clock outpaces.
    const hub = await startHub({ heartbeatTimeoutMs: 250 })
    const dialer = makeDialer(hub.url, { heartbeatIntervalMs: 50, heartbeatTimeoutMs: 200 })
    let lost = false
    hub.gateway.events.on('runner-lost', () => {
      lost = true
    })
    dialer.start()
    await dialer.events.once('connected')

    // 3× the watchdog window while heartbeating well inside it.
    await new Promise((resolve) => setTimeout(resolve, 750))
    expect(lost).toBe(false)
    expect(hub.gateway.listRunners()).toHaveLength(1)
  })

  it('usability tracks the heartbeat window, and agrees with the watchdog at its edge', async () => {
    // The watchdog tears down at `lastSeenAt + heartbeatTimeoutMs`, which is the
    // same instant staleness begins — so in NORMAL operation `listRunners` and
    // `listUsableRunners` do not diverge, and this test pins that.
    //
    // The read-time staleness check is still not redundant: `setTimeout` fires
    // late under load (and the timer is `unref`'d), so the watchdog's teardown can
    // lag the window it enforces. Computing usability on read is exact regardless
    // of when the timer actually runs — which matters because a routed dispatch
    // into that lag is precisely what fails.
    vi.useFakeTimers()
    const hub = await startHub({ heartbeatTimeoutMs: 5_000 })
    const dialer = makeDialer(hub.url, { heartbeatIntervalMs: 0 }) // never heartbeats
    dialer.start()
    await dialer.events.once('connected')

    expect(hub.gateway.listUsableRunners()).toHaveLength(1)
    expect(hub.gateway.isRunnerUsable('runner-1')).toBe(true)

    // Inside the window: still usable.
    await vi.advanceTimersByTimeAsync(4_000)
    expect(hub.gateway.isRunnerUsable('runner-1')).toBe(true)

    // Past it: unusable, and the watchdog has also reaped the connection.
    await vi.advanceTimersByTimeAsync(1_001)
    expect(hub.gateway.listUsableRunners()).toEqual([])
    expect(hub.gateway.listRunners()).toEqual([])
    expect(hub.gateway.isRunnerUsable('runner-1')).toBe(false)
  })

  it('isRunnerUsable is false for an unknown runner id', async () => {
    const hub = await startHub()
    expect(hub.gateway.isRunnerUsable('never-enrolled')).toBe(false)
    expect(hub.gateway.listUsableRunners()).toEqual([])
  })

  it('a heartbeating runner stays usable, not just listed', async () => {
    const hub = await startHub({ heartbeatTimeoutMs: 250 })
    const dialer = makeDialer(hub.url, { heartbeatIntervalMs: 50, heartbeatTimeoutMs: 200 })
    dialer.start()
    await dialer.events.once('connected')

    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(hub.gateway.listUsableRunners()).toHaveLength(1)
    expect(hub.gateway.isRunnerUsable('runner-1')).toBe(true)
  })
})

describe('join-token recovery (single-use token already spent)', () => {
  // The dead-end this closes: join tokens are single-use, and the dialer enrolls as
  // a FALLBACK whenever its stored api key fails verification (rebuilt hub-auth,
  // wiped runners row, restored backup). It then presents a token the hub has
  // already consumed, gets an explicit refusal, and — before this — treated that as
  // fatal. The runner never returned until its process restarted, which with
  // runners as the only execution path means nothing can run at all.

  it('re-mints and enrolls when the configured token is refused', async () => {
    const hub = await startHub()
    // The store holds credentials the hub does not recognize (its auth state was
    // rebuilt), so `hello` is rejected and the dialer falls back to enroll.
    const store = createMemoryCredentialStore()
    await store.save({ runnerId: 'runner-stale', apiKey: 'key-from-a-previous-life' })

    let minted = 0
    const dialer = makeDialer(hub.url, {
      credentialStore: store,
      joinToken: 'jt-SPENT',
      refreshJoinToken: async () => {
        minted += 1
        return 'jt-valid' // what the memory auth accepts
      }
    })
    dialer.start()

    const connected = await dialer.events.once('connected')
    expect(connected.mode).toBe('enroll')
    expect(minted).toBe(1)
    // Two enroll attempts: the spent token, then the fresh one.
    expect(hub.auth.enrollCalls.map((c) => c.joinToken)).toEqual(['jt-SPENT', 'jt-valid'])
    // And the recovered credentials are persisted for next boot.
    expect((await store.load())?.apiKey).toMatch(/^key-/)
  })

  it('gives up fatally when the fresh token is ALSO refused (no mint loop)', async () => {
    const hub = await startHub()
    let minted = 0
    const dialer = makeDialer(hub.url, {
      joinToken: 'jt-WRONG',
      refreshJoinToken: async () => {
        minted += 1
        return 'jt-ALSO-WRONG'
      }
    })
    const errorEvent = dialer.events.once('error')
    dialer.start()

    const { fatal, error } = await errorEvent
    expect(fatal).toBe(true)
    expect(error.message).toContain('fresh token')
    // Exactly one re-mint per attempt — a hub refusing everything must not spin.
    expect(minted).toBe(1)
    await dialer.events.once('disconnected')
    expect(dialer.state).toBe('stopped')
  })

  it('stays fatal without a refreshJoinToken (unchanged default)', async () => {
    const hub = await startHub()
    const dialer = makeDialer(hub.url, { joinToken: 'jt-WRONG' })
    const errorEvent = dialer.events.once('error')
    dialer.start()

    const { fatal, error, reason } = await errorEvent
    expect(fatal).toBe(true)
    expect(reason).toBe('needs-re-enrollment')
    expect(error.message).not.toContain('fresh token')
    expect(hub.auth.enrollCalls).toHaveLength(1)
  })

  it('does not re-mint on a protocol mismatch (a fresh token cannot help)', async () => {
    const hub = await startHub({
      verifyEnrollment: async () => {
        throw new RpcError(RunnerTransportErrorCodes.protocolMismatch, 'protocol too old')
      }
    })
    let minted = 0
    const dialer = makeDialer(hub.url, {
      joinToken: 'jt-valid',
      refreshJoinToken: async () => {
        minted += 1
        return 'jt-valid'
      }
    })
    const errorEvent = dialer.events.once('error')
    dialer.start()

    const { fatal } = await errorEvent
    expect(fatal).toBe(true)
    expect(minted).toBe(0)
  })
})

describe('needs-re-enrollment (the hub no longer recognizes this runner)', () => {
  // The real-world shape: the runner holds working-looking credentials, but the hub
  // cannot verify them because ITS state changed — storage deleted, one of the two
  // DBs (hub-auth.sqlite / the runners row) restored without the other, or the
  // runner revoked. All human actions, so the answer is "enroll it again", not a
  // retry and not an automatic re-mint.
  it('reports needs-re-enrollment with an actionable message, and stops', async () => {
    const hub = await startHub()
    const store = createMemoryCredentialStore()
    await store.save({ runnerId: 'runner-forgotten', apiKey: 'key-the-hub-never-heard-of' })

    // No join token: nothing to fall back on, which is the steady state for a
    // runner enrolled long ago (the token was consumed at enrollment).
    const dialer = makeDialer(hub.url, { credentialStore: store, joinToken: undefined })
    const errorEvent = dialer.events.once('error')
    dialer.start()

    const { fatal, reason, error } = await errorEvent
    expect(fatal).toBe(true)
    expect(reason).toBe('needs-re-enrollment')
    // The message must tell an operator what to DO — this is the one failure they
    // can fix, and it used to read "join token rejected: unknown".
    expect(error.message).toContain('enrolled again')
    expect(error.message).toContain('Settings → Runners')

    await dialer.events.once('disconnected')
    expect(dialer.state).toBe('stopped')
    // It does NOT keep retrying: the hub's answer will not change on its own.
    expect(hub.auth.helloCalls).toHaveLength(1)
  })

  it('a transient hub error is NOT needs-re-enrollment (it reconnects)', async () => {
    // Only an explicit credential refusal means the identity is gone. A hub blip
    // must stay on the backoff path, or a restart would look like a lost runner.
    let calls = 0
    const hub = await startHub({
      verifyApiKey: async () => {
        calls += 1
        throw new RpcError(JSON_RPC_INTERNAL_ERROR, 'hub is having a moment')
      }
    })
    const store = createMemoryCredentialStore()
    await store.save({ runnerId: 'runner-1', apiKey: 'key-ok' })

    const dialer = makeDialer(hub.url, { credentialStore: store, joinToken: undefined })
    let sawFatal = false
    dialer.events.on('error', (e) => {
      if (e.fatal) sawFatal = true
    })
    dialer.start()

    await dialer.events.once('reconnect-scheduled')
    expect(sawFatal).toBe(false)
    expect(calls).toBeGreaterThan(0)
    await dialer.stop()
  })
})
