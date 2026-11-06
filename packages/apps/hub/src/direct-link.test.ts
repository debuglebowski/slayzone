/**
 * The hub's direct-link issuer (docs/direct-link.md): gate once, register only the
 * token's hash on the computer, answer the client, audit without the token.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  currentSecurityContext,
  runWithSecurityContext,
  setSecurityLogSink
} from '@slayzone/platform/security-log'
import {
  DIRECT_GRANT_TTL_MS,
  DIRECT_LINK_PROTOCOL,
  HubToComputerMethods
} from '@slayzone/computer-transport/shared'
import { createComputerRequestAuthorizer } from './computer-request-authorizer'
import { createDirectLinkIssuer, type DirectLinkIssuerDeps } from './direct-link'

let lines: Record<string, unknown>[] = []
afterEach(() => {
  setSecurityLogSink()
  lines = []
})

interface Computer {
  computerId: string
  directAddress: string | null
  peerLoopback: boolean
  directRtc?: boolean
}

function setup(over: Partial<DirectLinkIssuerDeps> = {}, computers?: Computer[]) {
  setSecurityLogSink((line) => lines.push(JSON.parse(line)))
  const requests: Array<{ computerId: string; method: string; params: Record<string, unknown> }> =
    []
  const gated: Array<{ computerId: string; work: unknown }> = []
  const list = computers ?? [
    { computerId: 'c-local', directAddress: '127.0.0.1:5001', peerLoopback: true },
    { computerId: 'c-remote', directAddress: 'box.example:7443', peerLoopback: false },
    { computerId: 'c-none', directAddress: null, peerLoopback: false }
  ]
  const deps: DirectLinkIssuerDeps = {
    gateway: {
      listUsableComputers: () => list,
      request: async (computerId, method, params) => {
        requests.push({ computerId, method, params: params as Record<string, unknown> })
        return method === HubToComputerMethods.directGrant ? { ok: true } : { revoked: 0 }
      }
    },
    resolvePty: async (sessionId) =>
      sessionId === 'gone'
        ? null
        : sessionId === 'hub-owned'
          ? { computerId: 'c-local', direct: false, taskId: 'task-1' }
          : {
              computerId: sessionId.startsWith('r') ? 'c-remote' : 'c-local',
              direct: true,
              taskId: sessionId.startsWith('other') ? 'task-2' : 'task-1'
            },
    resolveChat: async (tabId) =>
      tabId === 'gone' ? null : { computerId: 'c-local', epoch: 4, taskId: 'task-1' },
    gate: async (computerId, work) => {
      gated.push({ computerId, work })
    },
    ...over
  }
  return { issuer: createDirectLinkIssuer(deps), requests, gated }
}

const local = { userId: 'u1', ip: '127.0.0.1' }
const remoteClient = { userId: 'u1', ip: '198.51.100.7' }

describe('direct-link issuer', () => {
  it('registers the hash on the computer first, then hands the client the raw token', async () => {
    const { issuer, requests, gated } = setup()
    const out = await issuer.issue({ kind: 'pty', sessionId: 't:t', taskId: 'task-1' }, local)
    expect(out).toMatchObject({
      available: true,
      computerId: 'c-local',
      address: '127.0.0.1:5001',
      expiresInMs: DIRECT_GRANT_TTL_MS,
      protocol: DIRECT_LINK_PROTOCOL
    })
    if (!out.available) throw new Error('unreachable')
    expect(out.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(requests).toEqual([
      {
        computerId: 'c-local',
        method: HubToComputerMethods.directGrant,
        params: {
          grantId: out.grantId,
          tokenHash: createHash('sha256').update(out.token).digest('hex'),
          userId: 'u1',
          resource: { kind: 'pty', sessionId: 't:t' },
          ttlMs: DIRECT_GRANT_TTL_MS
        }
      }
    ])
    expect(JSON.stringify(requests)).not.toContain(out.token)
    expect(gated).toEqual([{ computerId: 'c-local', work: { kind: 'session', id: 't:t' } }])
  })

  it('pins a chat grant to the epoch the hub holds, gated as the tab’s task', async () => {
    const { issuer, requests, gated } = setup()
    const out = await issuer.issue({ kind: 'chat', tabId: 'tab-1', taskId: 'task-1' }, local)
    expect(out.available).toBe(true)
    expect(requests[0]?.params.resource).toEqual({ kind: 'chat', tabId: 'tab-1', epoch: 4 })
    expect(gated[0]).toEqual({ computerId: 'c-local', work: { kind: 'task', id: 'task-1' } })
  })

  it('audits each issue with grant id, computer and resource — never the token', async () => {
    const { issuer } = setup()
    const out = await issuer.issue({ kind: 'pty', sessionId: 't:t', taskId: 'task-1' }, local)
    if (!out.available) throw new Error('unreachable')
    const line = lines.find((l) => l.event === 'computer.direct_grant')
    expect(line).toMatchObject({
      outcome: 'success',
      targetKind: 'computer',
      targetId: 'c-local',
      detail: { grantId: out.grantId, resource: 'pty', ttlMs: DIRECT_GRANT_TTL_MS }
    })
    expect(JSON.stringify(lines)).not.toContain(out.token)
  })

  it('offers a loopback listener only when the client and the computer are both on the hub’s machine', async () => {
    const { issuer, requests } = setup()
    expect(
      await issuer.issue({ kind: 'pty', sessionId: 't:t', taskId: 'task-1' }, remoteClient)
    ).toEqual({
      available: false,
      reason: 'unreachable'
    })
    const { issuer: other } = setup({}, [
      { computerId: 'c-local', directAddress: '127.0.0.1:5001', peerLoopback: false }
    ])
    expect(await other.issue({ kind: 'pty', sessionId: 't:t', taskId: 'task-1' }, local)).toEqual({
      available: false,
      reason: 'unreachable'
    })
    expect(requests).toEqual([])
  })

  it('offers a public address to any client', async () => {
    const { issuer } = setup()
    expect(
      await issuer.issue({ kind: 'pty', sessionId: 'r1', taskId: 'task-1' }, remoteClient)
    ).toMatchObject({
      available: true,
      address: 'box.example:7443'
    })
  })

  it('answers unavailable, never an error, when there is nothing direct to offer', async () => {
    const { issuer } = setup()
    expect(await issuer.issue({ kind: 'pty', sessionId: 'gone', taskId: 'task-1' }, local)).toEqual(
      {
        available: false,
        reason: 'no-computer'
      }
    )
    expect(await issuer.issue({ kind: 'chat', tabId: 'gone', taskId: 'task-1' }, local)).toEqual({
      available: false,
      reason: 'no-computer'
    })
    expect(
      await issuer.issue({ kind: 'pty', sessionId: 'hub-owned', taskId: 'task-1' }, local)
    ).toEqual({
      available: false,
      reason: 'not-direct'
    })
    const { issuer: none } = setup({}, [
      { computerId: 'c-local', directAddress: null, peerLoopback: true }
    ])
    expect(await none.issue({ kind: 'pty', sessionId: 't:t', taskId: 'task-1' }, local)).toEqual({
      available: false,
      reason: 'no-address'
    })
    const { issuer: offline } = setup({}, [])
    expect(await offline.issue({ kind: 'pty', sessionId: 't:t', taskId: 'task-1' }, local)).toEqual(
      {
        available: false,
        reason: 'no-computer'
      }
    )
  })

  // The target is a computer target (owner-checked by its task, G2): a session or
  // tab outside the task it names, or on another computer than it names, is refused.
  it('refuses a session or tab outside the task or computer the target names', async () => {
    const { issuer, requests } = setup()
    expect(await issuer.issue({ kind: 'pty', sessionId: 't:t', taskId: 'task-2' }, local)).toEqual({
      available: false,
      reason: 'wrong-target'
    })
    expect(await issuer.issue({ kind: 'chat', tabId: 'tab-1', taskId: 'task-2' }, local)).toEqual({
      available: false,
      reason: 'wrong-target'
    })
    expect(
      await issuer.issue(
        { kind: 'pty', sessionId: 't:t', taskId: 'task-1', computerId: 'c-remote' },
        local
      )
    ).toEqual({ available: false, reason: 'wrong-target' })
    expect(requests).toEqual([])
    expect(
      await issuer.issue(
        { kind: 'pty', sessionId: 't:t', taskId: 'task-1', computerId: 'c-local' },
        local
      )
    ).toMatchObject({ available: true })
  })

  it('refuses when the placement gate refuses, and registers nothing', async () => {
    const { issuer, requests } = setup({
      gate: async () => {
        throw new Error('not your computer')
      }
    })
    await expect(
      issuer.issue({ kind: 'pty', sessionId: 't:t', taskId: 'task-1' }, local)
    ).rejects.toThrow(/not your computer/)
    expect(requests).toEqual([])
  })

  it('remembers what it issued per computer (for reset and revocation)', async () => {
    const { issuer } = setup()
    const a = await issuer.issue({ kind: 'pty', sessionId: 't:t', taskId: 'task-1' }, local)
    const b = await issuer.issue({ kind: 'pty', sessionId: 'r1', taskId: 'task-1' }, remoteClient)
    if (!a.available || !b.available) throw new Error('unreachable')
    expect(issuer.heldGrantIds('c-local')).toEqual([a.grantId])
    expect(issuer.heldGrantIds('c-remote')).toEqual([b.grantId])
  })

  it('forgets a grant once its TTL has passed', async () => {
    let now = 0
    const { issuer } = setup({ now: () => now })
    await issuer.issue({ kind: 'pty', sessionId: 't:t', taskId: 'task-1' }, local)
    now += DIRECT_GRANT_TTL_MS
    expect(issuer.heldGrantIds('c-local')).toEqual([])
  })
})

describe('direct-link revocation', () => {
  async function issued() {
    const ctx = setup()
    const a = await ctx.issuer.issue({ kind: 'pty', sessionId: 't:t', taskId: 'task-1' }, local)
    const b = await ctx.issuer.issue(
      { kind: 'pty', sessionId: 'other:t', taskId: 'task-2' },
      { ...local, userId: 'u2' }
    )
    const c = await ctx.issuer.issue({ kind: 'chat', tabId: 'tab-1', taskId: 'task-1' }, local)
    const d = await ctx.issuer.issue(
      { kind: 'pty', sessionId: 'r1', taskId: 'task-1' },
      remoteClient
    )
    if (!a.available || !b.available || !c.available || !d.available) throw new Error('unreachable')
    ctx.requests.length = 0
    return { ...ctx, ids: { a: a.grantId, b: b.grantId, c: c.grantId, d: d.grantId } }
  }
  const revokes = (requests: Array<{ computerId: string; method: string; params: unknown }>) =>
    requests.filter((r) => r.method === HubToComputerMethods.directRevoke)

  it('revokes a user’s grants on each computer that holds them, by grant id, and forgets them', async () => {
    const { issuer, requests, ids } = await issued()
    await issuer.revoke({ by: 'user', userId: 'u1' }, 'user_disabled')
    expect(revokes(requests)).toEqual([
      {
        computerId: 'c-local',
        method: HubToComputerMethods.directRevoke,
        params: { by: 'grant', grantIds: [ids.a, ids.c] }
      },
      {
        computerId: 'c-remote',
        method: HubToComputerMethods.directRevoke,
        params: { by: 'grant', grantIds: [ids.d] }
      }
    ])
    expect(issuer.heldGrantIds('c-local')).toEqual([ids.b])
    expect(lines.filter((l) => l.event === 'computer.direct_revoke')).toEqual([
      expect.objectContaining({
        targetId: 'c-local',
        detail: { reason: 'user_disabled', grants: 2 }
      }),
      expect.objectContaining({
        targetId: 'c-remote',
        detail: { reason: 'user_disabled', grants: 1 }
      })
    ])
  })

  it('revokes a task’s grants (pty and chat)', async () => {
    const { issuer, requests, ids } = await issued()
    await issuer.revoke({ by: 'task', taskId: 'task-1' }, 'task_closed')
    expect(revokes(requests).map((r) => r.params)).toEqual([
      { by: 'grant', grantIds: [ids.a, ids.c] },
      { by: 'grant', grantIds: [ids.d] }
    ])
    expect(issuer.heldGrantIds('c-local')).toEqual([ids.b])
  })

  it('revokes one session or tab', async () => {
    const { issuer, requests, ids } = await issued()
    await issuer.revoke({ by: 'target', target: { kind: 'chat', tabId: 'tab-1' } }, 'chat_moved')
    expect(revokes(requests).map((r) => r.params)).toEqual([{ by: 'grant', grantIds: [ids.c] }])
  })

  it('revokes a chat tab’s grants the moment its ownership moves (no waiting out the TTL)', async () => {
    let changed: ((tabIds: readonly string[]) => void) | undefined
    const ctx = setup({
      onChatOwnershipChange: (listener) => {
        changed = listener
        return () => {}
      }
    })
    const c = await ctx.issuer.issue({ kind: 'chat', tabId: 'tab-1', taskId: 'task-1' }, local)
    if (!c.available) throw new Error('unreachable')
    ctx.requests.length = 0
    changed?.(['tab-1'])
    await new Promise((r) => setTimeout(r, 0))
    expect(revokes(ctx.requests).map((r) => r.params)).toEqual([
      { by: 'grant', grantIds: [c.grantId] }
    ])
    expect(lines.filter((l) => l.event === 'computer.direct_revoke').at(-1)).toMatchObject({
      detail: { reason: 'chat_ownership_changed', grants: 1 }
    })
  })

  it('a revocation that runs while a grant is being registered still drops that grant', async () => {
    for (const which of [
      { by: 'task', taskId: 'task-1' },
      { by: 'user', userId: 'u1' },
      { by: 'target', target: { kind: 'pty', sessionId: 't:t' } },
      { by: 'computer', computerId: 'c-local' }
    ] as const) {
      let release: (() => void) | undefined
      const ctx = setup({
        gateway: {
          listUsableComputers: () => [
            { computerId: 'c-local', directAddress: '127.0.0.1:5001', peerLoopback: true }
          ],
          request: async (computerId, method, params) => {
            ctx.requests.push({ computerId, method, params: params as Record<string, unknown> })
            if (method === HubToComputerMethods.directGrant)
              await new Promise<void>((r) => (release = r))
            return { ok: true }
          }
        }
      })
      const issuing = ctx.issuer.issue({ kind: 'pty', sessionId: 't:t', taskId: 'task-1' }, local)
      await new Promise((r) => setTimeout(r, 0))
      await ctx.issuer.revoke(which, 'race')
      release?.()
      expect(await issuing, which.by).toEqual({ available: false, reason: 'revoked' })
      const grantId = ctx.requests.find((r) => r.method === HubToComputerMethods.directGrant)
        ?.params.grantId
      // Revoked on the computer after it registered there, and never held here.
      const after = ctx.requests.at(-1)
      expect(after?.method, which.by).toBe(HubToComputerMethods.directRevoke)
      expect(after?.params, which.by).toEqual({ by: 'grant', grantIds: [grantId] })
      expect(ctx.issuer.heldGrantIds('c-local'), which.by).toEqual([])
    }
  })

  it('revokes everything on a revoked computer', async () => {
    const { issuer, requests } = await issued()
    await issuer.revoke({ by: 'computer', computerId: 'c-local' }, 'computer_revoked')
    expect(revokes(requests)).toEqual([
      { computerId: 'c-local', method: HubToComputerMethods.directRevoke, params: { by: 'all' } }
    ])
    expect(issuer.heldGrantIds('c-local')).toEqual([])
  })

  it('sends nothing when nothing matches, and survives an offline computer', async () => {
    const { issuer, requests } = await issued()
    await issuer.revoke({ by: 'user', userId: 'nobody' }, 'user_disabled')
    expect(revokes(requests)).toEqual([])
    const failing = setup({
      gateway: {
        listUsableComputers: () => [
          { computerId: 'c-local', directAddress: '127.0.0.1:1', peerLoopback: true }
        ],
        request: async (_c, method) => {
          if (method === HubToComputerMethods.directRevoke) throw new Error('offline')
          return { ok: true }
        }
      }
    })
    await failing.issuer.issue({ kind: 'pty', sessionId: 't:t', taskId: 'task-1' }, local)
    lines = []
    // Forgotten anyway: the reconnect reset drops it on the computer. The failure is
    // reported, and audited as one.
    const out = await failing.issuer.revoke({ by: 'user', userId: 'u1' }, 'user_disabled')
    expect(out.failed).toEqual([{ computerId: 'c-local', error: 'Error: offline' }])
    expect(failing.issuer.heldGrantIds('c-local')).toEqual([])
    expect(lines.filter((l) => l.event === 'computer.direct_revoke')).toEqual([
      expect.objectContaining({ outcome: 'failure', targetId: 'c-local' })
    ])
  })

  // G2: on a hub with login every gateway request made inside a caller's request is
  // owner-checked against that caller. A revocation is the hub's own act: an admin
  // disabling user B (or revoking B's computer) must still reach B's computer.
  it('runs as the hub: an admin’s request still revokes on a computer the admin does not own', async () => {
    const owner: Record<string, string> = { 'c-local': 'u-b' }
    const authorize = createComputerRequestAuthorizer(async (computerId) => {
      if (currentSecurityContext()?.actor !== owner[computerId])
        throw new Error('not your computer')
    })
    if (!authorize) throw new Error('unreachable')
    const delivered: string[] = []
    const ctx = setup({
      gateway: {
        listUsableComputers: () => [
          { computerId: 'c-local', directAddress: '127.0.0.1:1', peerLoopback: true }
        ],
        request: async (computerId, method) => {
          await authorize(computerId, method)
          delivered.push(method)
          return { ok: true }
        }
      }
    })
    const as = <T>(actor: string, fn: () => Promise<T>) =>
      runWithSecurityContext({ actor, ip: '127.0.0.1', route: 'test' }, fn)
    await as('u-b', () =>
      ctx.issuer.issue(
        { kind: 'pty', sessionId: 't:t', taskId: 'task-1' },
        { ...local, userId: 'u-b' }
      )
    )
    lines = []
    const out = await as('admin', () =>
      ctx.issuer.revoke({ by: 'user', userId: 'u-b' }, 'user_disabled')
    )
    expect(out.failed).toEqual([])
    expect(delivered).toEqual([HubToComputerMethods.directGrant, HubToComputerMethods.directRevoke])
    expect(lines.filter((l) => l.event === 'computer.direct_revoke')).toEqual([
      expect.objectContaining({ outcome: 'success', targetId: 'c-local' })
    ])
    await as('admin', () =>
      ctx.issuer.revoke({ by: 'computer', computerId: 'c-local' }, 'computer_revoked')
    )
    await as('admin', () => ctx.issuer.computerConnected('c-local'))
    expect(delivered).toEqual([
      HubToComputerMethods.directGrant,
      HubToComputerMethods.directRevoke,
      HubToComputerMethods.directRevoke,
      HubToComputerMethods.directReset
    ])
  })

  it('resets a (re)connected computer to exactly the grants this hub still holds', async () => {
    const { issuer, requests, ids } = await issued()
    await issuer.computerConnected('c-local')
    expect(requests).toEqual([
      {
        computerId: 'c-local',
        method: HubToComputerMethods.directReset,
        params: { keep: [ids.a, ids.b, ids.c] }
      }
    ])
    // A fresh hub holds nothing: the computer drops every grant.
    const fresh = setup()
    await fresh.issuer.computerConnected('c-remote')
    expect(fresh.requests).toEqual([
      { computerId: 'c-remote', method: HubToComputerMethods.directReset, params: { keep: [] } }
    ])
  })
})

// M5: a remote computer without a reachable listener gets a WebRTC direct link,
// brokered by the hub (docs/direct-link.md). Only for a client that says it speaks
// WebRTC, and only to a computer that advertises it.
describe('direct-link issuer: WebRTC', () => {
  const rtcComputers: Computer[] = [
    { computerId: 'c-local', directAddress: '127.0.0.1:5001', peerLoopback: true, directRtc: true },
    { computerId: 'c-remote', directAddress: null, peerLoopback: false, directRtc: true },
    { computerId: 'c-none', directAddress: null, peerLoopback: false, directRtc: false }
  ]
  const STUN = ['stun.cloudflare.com:3478']
  function rtcSetup(over: Partial<DirectLinkIssuerDeps> = {}) {
    return setup(
      {
        stunAddresses: () => STUN,
        resolvePty: async (sessionId) => ({
          computerId: sessionId.startsWith('r')
            ? 'c-remote'
            : sessionId.startsWith('n')
              ? 'c-none'
              : 'c-local',
          direct: true,
          taskId: 'task-1'
        }),
        ...over
      },
      rtcComputers
    )
  }
  const pty = (sessionId: string) => ({ kind: 'pty' as const, sessionId, taskId: 'task-1' })

  it('offers WebRTC to a client that speaks it when the computer has no reachable listener', async () => {
    const { issuer, requests } = rtcSetup()
    const out = await issuer.issue(pty('r1'), remoteClient, { transports: ['ws', 'webrtc'] })
    expect(out).toMatchObject({
      available: true,
      transport: 'webrtc',
      computerId: 'c-remote',
      stunAddresses: STUN
    })
    expect(requests.map((r) => r.method)).toEqual([HubToComputerMethods.directGrant])
    // A loopback listener a remote client cannot dial: WebRTC too.
    expect(
      await issuer.issue(pty('t:t'), remoteClient, { transports: ['ws', 'webrtc'] })
    ).toMatchObject({ available: true, transport: 'webrtc', computerId: 'c-local' })
  })

  it('prefers the WebSocket listener when it is reachable', async () => {
    const { issuer } = rtcSetup()
    expect(await issuer.issue(pty('t:t'), local, { transports: ['ws', 'webrtc'] })).toMatchObject({
      available: true,
      transport: 'ws',
      address: '127.0.0.1:5001'
    })
  })

  it('keeps today’s answers for an older client, or a computer without WebRTC', async () => {
    const { issuer } = rtcSetup()
    expect(await issuer.issue(pty('r1'), remoteClient)).toEqual({
      available: false,
      reason: 'no-address'
    })
    expect(await issuer.issue(pty('n1'), remoteClient, { transports: ['webrtc'] })).toEqual({
      available: false,
      reason: 'no-address'
    })
  })

  it('brokers the offer to the granted computer, with STUN and the client address', async () => {
    const { issuer, requests } = rtcSetup({
      gateway: {
        listUsableComputers: () => rtcComputers,
        request: async (computerId, method, params) => {
          requests.push({ computerId, method, params: params as Record<string, unknown> })
          return method === HubToComputerMethods.directRtcOffer
            ? { sdp: 'answer-sdp' }
            : { ok: true }
        }
      }
    })
    const out = await issuer.issue(pty('r1'), remoteClient, { transports: ['webrtc'] })
    if (!out.available) throw new Error('unreachable')
    lines = []
    expect(await issuer.rtcConnect(out.grantId, 'offer-sdp', remoteClient)).toEqual({
      ok: true,
      sdp: 'answer-sdp'
    })
    expect(requests.at(-1)).toEqual({
      computerId: 'c-remote',
      method: HubToComputerMethods.directRtcOffer,
      params: {
        grantId: out.grantId,
        sdp: 'offer-sdp',
        stunAddresses: STUN,
        clientAddress: remoteClient.ip
      }
    })
    expect(lines.filter((l) => l.event === 'computer.direct_rtc_signal')).toEqual([
      expect.objectContaining({ outcome: 'success', targetId: 'c-remote' })
    ])
    expect(JSON.stringify(lines)).not.toContain('offer-sdp')
  })

  it('refuses an offer for a grant the caller does not hold', async () => {
    const { issuer, requests } = rtcSetup()
    const out = await issuer.issue(pty('r1'), remoteClient, { transports: ['webrtc'] })
    if (!out.available) throw new Error('unreachable')
    const before = requests.length
    expect(await issuer.rtcConnect('nope', 'sdp', remoteClient)).toEqual({
      ok: false,
      reason: 'no-grant'
    })
    expect(
      await issuer.rtcConnect(out.grantId, 'sdp', { userId: 'someone-else', ip: '203.0.113.1' })
    ).toEqual({ ok: false, reason: 'no-grant' })
    expect(requests.length).toBe(before)
  })

  it('rate-limits signaling per user and per address', async () => {
    const { issuer } = rtcSetup({ signalLimitPerMinute: 2 })
    const out = await issuer.issue(pty('r1'), remoteClient, { transports: ['webrtc'] })
    if (!out.available) throw new Error('unreachable')
    // The fake computer does not answer (refused), but the first two are let through.
    expect(await issuer.rtcConnect(out.grantId, 'sdp', remoteClient)).toEqual({
      ok: false,
      reason: 'refused'
    })
    expect((await issuer.rtcConnect(out.grantId, 'sdp', remoteClient)).ok).toBe(false)
    expect(await issuer.rtcConnect(out.grantId, 'sdp', remoteClient)).toEqual({
      ok: false,
      reason: 'rate-limited'
    })
  })
})

it('the SDP limit clients see equals the one the computer enforces', async () => {
  const { DIRECT_RTC_MAX_SDP: clientMax } = await import('@slayzone/computers/shared')
  const { DIRECT_RTC_MAX_SDP: wireMax } = await import('@slayzone/computer-transport/shared')
  expect(clientMax).toBe(wireMax)
})
