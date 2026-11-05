/**
 * The client's direct-link manager (docs/direct-link.md): ask the hub, probe over
 * HTTP, open one socket per computer, renew through the hub, fall back to the
 * relay — and never let a dead computer cost the renderer a failed WebSocket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDirectLinkManager,
  directLinkManagerFor,
  disposeDirectLinkManagers,
  setDirectLinkProbe,
  setDirectRtcPeerFactory,
  type DirectConnection,
  type DirectIssueResult,
  type DirectLinkManagerOptions
} from './direct-link'

afterEach(() => {
  vi.useRealTimers()
})

const available = (over: Partial<Extract<DirectIssueResult, { address: string }>> = {}) =>
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
  const released: unknown[] = []
  const closeListeners: Array<() => void> = []
  let closed = false
  const conn: DirectConnection & {
    authorized: string[]
    released: unknown[]
    drop: () => void
    closed: () => boolean
  } = {
    client: {
      ping: {
        query: () =>
          opts.ready === false ? new Promise(() => {}) : Promise.resolve({ protocol: 1 })
      },
      authorize: {
        mutate: async ({ token }: { token: string }) => {
          authorized.push(token)
          return { grantId: 'x', resource: { kind: 'pty', sessionId: 's' }, expiresInMs: 1 }
        }
      },
      release: {
        mutate: async (target: unknown) => {
          released.push(target)
          return { released: true }
        }
      }
    } as never,
    onClose: (cb) => closeListeners.push(cb),
    close: () => {
      closed = true
    },
    authorized,
    released,
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

const pty = (sessionId = 's1') => ({ kind: 'pty' as const, sessionId, taskId: 't1' })

describe('acquire', () => {
  it('issues, probes the health path over HTTP, opens one socket and leases it', async () => {
    const { manager, opened, probes } = setup()
    const lease = await manager.acquire(pty())
    expect(lease?.computerId).toBe('c1')
    expect(probes).toEqual(['127.0.0.1:5001'])
    expect(opened).toEqual([{ url: 'ws://127.0.0.1:5001/direct/v1', token: expect.any(String) }])
  })

  it('derives the scheme from the host: a public address is https/wss', async () => {
    const { manager, opened, probes, setIssue } = setup()
    setIssue(() => available({ address: 'box.example:7443' }))
    await manager.acquire(pty())
    expect(probes).toEqual(['box.example:7443'])
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

  // M3: at boot every open tab's terminal and chat acquires at once. One computer must
  // still get ONE probe and ONE socket (the listener allows 64 per address; a refused
  // upgrade is a failed WebSocket connect, which slows the renderer's hub socket too).
  it('70 concurrent acquires for one computer share one probe and one socket', async () => {
    const { manager, opened, connections, probes } = setup()
    const leases = await Promise.all(
      Array.from({ length: 70 }, (_, i) => manager.acquire(pty(`s${i}`)))
    )
    expect(probes.length).toBe(1)
    expect(opened.length).toBe(1)
    expect(leases.every((l) => l !== null && l.client === leases[0]?.client)).toBe(true)
    // The opener's token rode the connection params; every other lease authorized on it.
    expect(connections[0]?.authorized.length).toBe(69)
    expect(manager.status()).toEqual([
      { computerId: 'c1', path: 'direct', transport: 'ws', address: '127.0.0.1:5001', leases: 70 }
    ])
  })

  it('concurrent acquires that fail to open all fall back, with one probe', async () => {
    const { manager, opened, probes, setProbe } = setup()
    setProbe(false)
    const leases = await Promise.all(
      Array.from({ length: 10 }, (_, i) => manager.acquire(pty(`s${i}`)))
    )
    expect(leases.every((l) => l === null)).toBe(true)
    expect(probes.length).toBe(1)
    expect(opened.length).toBe(0)
  })

  // M4: grants the client no longer uses must leave the computer's socket, or they
  // pile up to its per-socket cap. Only the LAST lease on a target releases it.
  it('releases its own grant on the computer when its last lease on the target ends', async () => {
    const { manager, connections, setIssue } = setup()
    let n = 0
    setIssue(() => available({ grantId: `g${++n}` }))
    const a = await manager.acquire(pty('s1'))
    const b = await manager.acquire(pty('s1'))
    const c = await manager.acquire(pty('s2'))
    a?.release()
    await Promise.resolve()
    expect(connections[0]?.released).toEqual([])
    b?.release()
    c?.release()
    await Promise.resolve()
    expect(connections[0]?.released).toEqual([{ grantId: 'g2' }, { grantId: 'g3' }])
  })

  // R4: a holder that is still acquiring the same target (its authorize in flight)
  // must not lose the grant it is about to get to another holder's release.
  it('never releases a target while another acquire for it is in flight', async () => {
    const authorizing: Array<() => void> = []
    const { manager, connections, setIssue } = setup()
    let n = 0
    setIssue(() => available({ grantId: `g${++n}` }))
    const a = await manager.acquire(pty('s1'))
    const conn = connections[0]!
    const realAuthorize = (
      conn.client as { authorize: { mutate: (i: unknown) => Promise<unknown> } }
    ).authorize.mutate
    ;(conn.client as { authorize: { mutate: (i: unknown) => Promise<unknown> } }).authorize.mutate =
      (input) => new Promise((resolve) => authorizing.push(() => resolve(realAuthorize(input))))
    const pendingB = manager.acquire(pty('s1'))
    await vi.waitFor(() => expect(authorizing.length).toBe(1))
    a?.release()
    await Promise.resolve()
    expect(conn.released).toEqual([])
    authorizing[0]!()
    const b = await pendingB
    b?.release()
    await Promise.resolve()
    expect(conn.released).toEqual([{ grantId: 'g2' }])
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
        throw Object.assign(new Error('No "mutation"-procedure on path'), {
          data: { code: 'NOT_FOUND' }
        })
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

describe('per-hub registry', () => {
  afterEach(() => {
    disposeDirectLinkManagers()
    setDirectLinkProbe(null)
  })

  function hubClient() {
    let onStatus: ((c: { computerId: string; connected: boolean }) => void) | undefined
    const client = {
      computers: {
        issueDirectLink: {
          mutate: async () => ({ available: false as const, reason: 'no-address' })
        },
        onStatusChange: {
          subscribe: (_: undefined, opts: { onData: typeof onStatus }) => {
            onStatus = opts.onData
            return { unsubscribe: () => undefined }
          }
        }
      }
    }
    return { client, status: (c: { computerId: string; connected: boolean }) => onStatus?.(c) }
  }

  it('keeps one manager per hub, and turns a computer reconnect into computerConnected', () => {
    const { client, status } = hubClient()
    const a = directLinkManagerFor('hub-a', client)
    expect(directLinkManagerFor('hub-a', client)).toBe(a)
    expect(directLinkManagerFor('hub-b', hubClient().client)).not.toBe(a)
    const told: string[] = []
    a.onComputerConnected((id) => told.push(id))
    status({ computerId: 'c1', connected: false })
    status({ computerId: 'c1', connected: true })
    expect(told).toEqual(['c1'])
  })

  it('probes through the installed probe (the desktop asks its main process)', async () => {
    const asked: string[] = []
    setDirectLinkProbe(async (address) => {
      asked.push(address)
      return false
    })
    const client = {
      computers: {
        issueDirectLink: { mutate: async () => available() },
        onStatusChange: { subscribe: () => ({ unsubscribe: () => undefined }) }
      }
    }
    expect(await directLinkManagerFor('hub-p', client).acquire(pty())).toBeNull()
    expect(asked).toEqual(['127.0.0.1:5001'])
  })
})

describe('status (Diagnostics)', () => {
  it('reports a computer on the direct link with its address and leases, or on the relay with why and when it retries', async () => {
    vi.useFakeTimers()
    const { manager, setProbe, setIssue } = setup()
    await manager.acquire(pty('s1'))
    await manager.acquire(pty('s2'))
    expect(manager.status()).toEqual([
      { computerId: 'c1', path: 'direct', transport: 'ws', address: '127.0.0.1:5001', leases: 2 }
    ])
    setIssue(() => available({ computerId: 'c2', address: '127.0.0.1:6000' }))
    setProbe(false)
    await manager.acquire(pty('s3'))
    expect(manager.status()).toContainEqual({
      computerId: 'c2',
      path: 'relay',
      reason: 'probe',
      retryInMs: 60_000
    })
  })
})

// M5: WebRTC for computers without a reachable listener (docs/direct-link.md).
describe('acquire over WebRTC', () => {
  const rtcIssued = (): DirectIssueResult => ({
    available: true,
    transport: 'webrtc',
    computerId: 'c9',
    token: `tok-${Math.random()}`,
    grantId: `g-${Math.random()}`,
    expiresInMs: 300_000,
    protocol: 1,
    stunAddresses: ['stun.cloudflare.com:3478']
  })

  function rtcSetup(opts: { fail?: boolean } = {}) {
    const rtcOpened: Array<{ grantId: string; token: string; stunAddresses: string[] }> = []
    const connections: Array<ReturnType<typeof fakeConnection>> = []
    const ctx = setup({
      issue: async () => rtcIssued(),
      rtc: {
        createPeer: () => {
          throw new Error('not used: openRtcConnection is injected')
        },
        connect: async () => ({ ok: false, reason: 'refused' })
      },
      openRtcConnection: async (o) => {
        rtcOpened.push({ grantId: o.grantId, token: o.token, stunAddresses: [...o.stunAddresses] })
        await new Promise((r) => setTimeout(r, 5))
        if (opts.fail) throw new Error('direct link did not connect')
        const c = fakeConnection()
        connections.push(c)
        return c
      }
    })
    return { ...ctx, rtcOpened, rtcConnections: connections }
  }

  it('connects over WebRTC (no HTTP probe), and reports the transport', async () => {
    const { manager, probes, opened, rtcOpened } = rtcSetup()
    const lease = await manager.acquire(pty('s1'))
    expect(lease?.computerId).toBe('c9')
    expect(probes).toEqual([])
    expect(opened).toEqual([])
    expect(rtcOpened).toEqual([
      {
        grantId: expect.any(String),
        token: expect.any(String),
        stunAddresses: ['stun.cloudflare.com:3478']
      }
    ])
    expect(manager.status()).toEqual([
      { computerId: 'c9', path: 'direct', transport: 'webrtc', address: null, leases: 1 }
    ])
  })

  it('70 concurrent acquires share one peer connection', async () => {
    const { manager, rtcOpened, rtcConnections } = rtcSetup()
    const leases = await Promise.all(
      Array.from({ length: 70 }, (_, i) => manager.acquire(pty(`s${i}`)))
    )
    expect(rtcOpened.length).toBe(1)
    expect(leases.every((l) => l !== null && l.client === leases[0]?.client)).toBe(true)
    expect(rtcConnections[0]?.authorized.length).toBe(69)
  })

  it('a failed connect falls back to the relay and backs off', async () => {
    const { manager, rtcOpened } = rtcSetup({ fail: true })
    expect(await manager.acquire(pty('s1'))).toBeNull()
    expect(await manager.acquire(pty('s2'))).toBeNull()
    expect(rtcOpened.length).toBe(1)
    expect(manager.status()).toEqual([
      { computerId: 'c9', path: 'relay', reason: 'rtc', retryInMs: expect.any(Number) }
    ])
  })

  it('a renewal over WebRTC keeps the lease on the same peer', async () => {
    vi.useFakeTimers()
    const { manager, rtcConnections } = rtcSetup()
    const lease = await vi.waitFor(() => manager.acquire(pty('s1')))
    const lost: string[] = []
    lease?.onLost((r) => lost.push(r))
    await vi.advanceTimersByTimeAsync(150_001)
    expect(lost).toEqual([])
    expect(rtcConnections[0]?.authorized.length).toBe(1)
  })
})

describe('the registry advertises WebRTC only with a peer factory installed', () => {
  it('asks for webrtc once a factory is installed', async () => {
    const inputs: unknown[] = []
    const client = {
      computers: {
        issueDirectLink: {
          mutate: async (input: unknown) => {
            inputs.push(input)
            return { available: false as const, reason: 'no-address' }
          }
        },
        directRtcConnect: {
          mutate: async () => ({ ok: false as const, reason: 'refused' as const })
        },
        onStatusChange: { subscribe: () => ({ unsubscribe: () => undefined }) }
      }
    }
    setDirectLinkProbe(async () => true)
    try {
      await directLinkManagerFor('hub-a', client).acquire(pty('s1'))
      setDirectRtcPeerFactory(() => ({}) as RTCPeerConnection)
      disposeDirectLinkManagers()
      await directLinkManagerFor('hub-b', client).acquire(pty('s2'))
      expect(inputs).toEqual([
        { target: pty('s1'), transports: ['ws'] },
        { target: pty('s2'), transports: ['ws', 'webrtc'] }
      ])
    } finally {
      setDirectRtcPeerFactory(null)
      setDirectLinkProbe(null)
      disposeDirectLinkManagers()
    }
  })
})
