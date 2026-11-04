/**
 * The client's direct-link manager (docs/direct-link.md): ask the hub, probe over
 * HTTP, open one socket per computer, renew through the hub, fall back to the
 * relay — and never let a dead computer cost the renderer a failed WebSocket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDirectLinkManager,
  type DirectConnection,
  type DirectIssueResult,
  type DirectLinkManagerOptions
} from './direct-link'

afterEach(() => {
  vi.useRealTimers()
})

const available = (over: Partial<Extract<DirectIssueResult, { available: true }>> = {}) =>
  ({
    available: true,
    computerId: 'c1',
    address: '127.0.0.1:5001',
    token: `tok-${Math.random()}`,
    grantId: `g-${Math.random()}`,
    expiresInMs: 300_000,
    protocol: 1,
    ...over
  }) as const

function fakeConnection(opts: { ready?: boolean } = {}) {
  const authorized: string[] = []
  const closeListeners: Array<() => void> = []
  let closed = false
  const conn: DirectConnection & {
    authorized: string[]
    drop: () => void
    closed: () => boolean
  } = {
    client: {
      ping: { query: () => (opts.ready === false ? new Promise(() => {}) : Promise.resolve({ protocol: 1 })) },
      authorize: {
        mutate: async ({ token }: { token: string }) => {
          authorized.push(token)
          return { grantId: 'x', resource: { kind: 'pty', sessionId: 's' }, expiresInMs: 1 }
        }
      }
    } as never,
    onClose: (cb) => closeListeners.push(cb),
    close: () => {
      closed = true
    },
    authorized,
    drop: () => {
      for (const cb of closeListeners) cb()
    },
    closed: () => closed
  }
  return conn
}

function setup(over: Partial<DirectLinkManagerOptions> = {}) {
  const issued: unknown[] = []
  const opened: Array<{ url: string; token: string }> = []
  const connections: Array<ReturnType<typeof fakeConnection>> = []
  const probes: string[] = []
  let probeResult = true
  let issueResult: () => DirectIssueResult = () => available()
  const manager = createDirectLinkManager({
    issue: async (target) => {
      issued.push(target)
      return issueResult()
    },
    probe: async (url) => {
      probes.push(url)
      return probeResult
    },
    openConnection: ({ url, token }) => {
      opened.push({ url, token })
      const c = fakeConnection()
      connections.push(c)
      return c
    },
    ...over
  })
  return {
    manager,
    issued,
    opened,
    connections,
    probes,
    setProbe: (v: boolean) => {
      probeResult = v
    },
    setIssue: (f: () => DirectIssueResult) => {
      issueResult = f
    }
  }
}

const pty = (sessionId = 's1') => ({ kind: 'pty' as const, sessionId })

describe('acquire', () => {
  it('issues, probes the health path over HTTP, opens one socket and leases it', async () => {
    const { manager, opened, probes } = setup()
    const lease = await manager.acquire(pty())
    expect(lease?.computerId).toBe('c1')
    expect(probes).toEqual(['http://127.0.0.1:5001/direct/v1/health'])
    expect(opened).toEqual([{ url: 'ws://127.0.0.1:5001/direct/v1', token: expect.any(String) }])
  })

  it('derives the scheme from the host: a public address is https/wss', async () => {
    const { manager, opened, probes, setIssue } = setup()
    setIssue(() => available({ address: 'box.example:7443' }))
    await manager.acquire(pty())
    expect(probes).toEqual(['https://box.example:7443/direct/v1/health'])
    expect(opened[0]?.url).toBe('wss://box.example:7443/direct/v1')
  })

  it('shares one socket per computer: a second session authorizes on it', async () => {
    const { manager, opened, connections } = setup()
    const a = await manager.acquire(pty('s1'))
    const b = await manager.acquire(pty('s2'))
    expect(opened.length).toBe(1)
    expect(a?.client).toBe(b?.client)
    expect(connections[0]?.authorized.length).toBe(1)
  })

  it('returns null (use the relay) when the hub offers nothing', async () => {
    const { manager, setIssue, opened } = setup()
    setIssue(() => ({ available: false, reason: 'no-address' }))
    expect(await manager.acquire(pty())).toBeNull()
    expect(opened).toEqual([])
  })

  it('remembers a hub that cannot issue, and stops asking it', async () => {
    const { manager, issued } = setup({
      issue: async (target) => {
        issued.push(target)
        throw Object.assign(new Error('No "mutation"-procedure on path'), { data: { code: 'NOT_FOUND' } })
      }
    })
    expect(await manager.acquire(pty())).toBeNull()
    expect(await manager.acquire(pty())).toBeNull()
    expect(issued.length).toBe(1)
  })
})

describe('a failing direct path never delays the relay', () => {
  it('opens no WebSocket at all when the HTTP probe fails (no Chromium failed-connect strike)', async () => {
    const { manager, setProbe, opened } = setup()
    setProbe(false)
    expect(await manager.acquire(pty())).toBeNull()
    expect(opened).toEqual([])
  })

  it('backs off per computer: no probe and no hub call until the backoff ends, then doubles', async () => {
    vi.useFakeTimers()
    const { manager, setProbe, probes, issued } = setup()
    setProbe(false)
    await manager.acquire(pty())
    expect(probes.length).toBe(1)
    // Inside 60s: a known session is answered at once — no hub call, no probe.
    await vi.advanceTimersByTimeAsync(59_000)
    expect(await manager.acquire(pty())).toBeNull()
    expect(probes.length).toBe(1)
    expect(issued.length).toBe(1)
    // A session not seen yet must ask the hub where it is, but is not probed.
    expect(await manager.acquire(pty('s2'))).toBeNull()
    expect(issued.length).toBe(2)
    expect(probes.length).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await manager.acquire(pty())
    expect(probes.length).toBe(2)
    // Second failure: 120s.
    await vi.advanceTimersByTimeAsync(119_000)
    await manager.acquire(pty())
    expect(probes.length).toBe(2)
    await vi.advanceTimersByTimeAsync(1_000)
    await manager.acquire(pty())
    expect(probes.length).toBe(3)
  })

  it('gives up on a socket that does not answer within the deadline, and backs off', async () => {
    vi.useFakeTimers()
    const { manager, probes } = setup({
      openConnection: () => fakeConnection({ ready: false }),
      connectDeadlineMs: 3_000
    })
    const pending = manager.acquire(pty())
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await pending).toBeNull()
    await manager.acquire(pty())
    expect(probes.length).toBe(1)
  })

  it('every socket (re)open is gated by the probe, so the library cannot reconnect blindly', async () => {
    const seen: Array<() => Promise<boolean>> = []
    const { manager, setProbe } = setup({
      openConnection: ({ probe }) => {
        seen.push(probe)
        return fakeConnection()
      }
    })
    await manager.acquire(pty())
    setProbe(false)
    expect(await seen[0]?.()).toBe(false)
  })
})

describe('computer restarts (the local computer binds a new port each time)', () => {
  it('re-issues after the socket drops, and dials the new address', async () => {
    const { manager, opened, setIssue, connections } = setup()
    const lease = await manager.acquire(pty())
    const lost: string[] = []
    lease?.onLost((r) => lost.push(r))
    connections[0]?.drop()
    expect(lost).toEqual(['closed'])
    setIssue(() => available({ address: '127.0.0.1:6002' }))
    await manager.acquire(pty())
    expect(opened.map((o) => o.url)).toEqual([
      'ws://127.0.0.1:5001/direct/v1',
      'ws://127.0.0.1:6002/direct/v1'
    ])
  })

  it('a reconnected computer clears its backoff and drops sockets to its old address', async () => {
    vi.useFakeTimers()
    const { manager, setProbe, probes, connections } = setup()
    const lease = await manager.acquire(pty('s1'))
    const lost: string[] = []
    lease?.onLost((r) => lost.push(r))
    setProbe(false)
    await manager.acquire(pty('s2')) // reuses the socket: no probe
    manager.computerConnected('c1')
    expect(lost).toEqual(['computer-reconnected'])
    expect(connections[0]?.closed()).toBe(true)
    setProbe(true)
    await manager.acquire(pty('s1'))
    expect(probes.length).toBe(2)
  })
})

describe('renewal', () => {
  it('re-issues through the hub at half the TTL and authorizes the new token on the socket', async () => {
    vi.useFakeTimers()
    const { manager, issued, connections, setIssue } = setup()
    setIssue(() => available({ expiresInMs: 10_000, token: 'first' }))
    await manager.acquire(pty())
    setIssue(() => available({ expiresInMs: 10_000, token: 'second' }))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(issued.length).toBe(2)
    expect(connections[0]?.authorized).toEqual(['second'])
  })

  it('loses the lease when the hub refuses the renewal (access revoked, task closed)', async () => {
    vi.useFakeTimers()
    const { manager, setIssue } = setup()
    setIssue(() => available({ expiresInMs: 10_000 }))
    const lease = await manager.acquire(pty())
    const lost: string[] = []
    lease?.onLost((r) => lost.push(r))
    setIssue(() => ({ available: false, reason: 'no-computer' }))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(lost).toEqual(['renewal-refused'])
  })

  it('stops renewing a released lease, and closes the socket after the linger', async () => {
    vi.useFakeTimers()
    const { manager, issued, connections, setIssue } = setup({ lingerMs: 30_000 })
    setIssue(() => available({ expiresInMs: 10_000 }))
    const lease = await manager.acquire(pty())
    lease?.release()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(issued.length).toBe(1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(connections[0]?.closed()).toBe(true)
  })
})
