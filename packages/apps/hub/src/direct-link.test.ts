/**
 * The hub's direct-link issuer (docs/direct-link.md): gate once, register only the
 * token's hash on the computer, answer the client, audit without the token.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import {
  DIRECT_GRANT_TTL_MS,
  DIRECT_LINK_PROTOCOL,
  HubToComputerMethods
} from '@slayzone/computer-transport/shared'
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
}

function setup(over: Partial<DirectLinkIssuerDeps> = {}, computers?: Computer[]) {
  setSecurityLogSink((line) => lines.push(JSON.parse(line)))
  const requests: Array<{ computerId: string; method: string; params: Record<string, unknown> }> = []
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
          ? { computerId: 'c-local', direct: false }
          : { computerId: sessionId.startsWith('r') ? 'c-remote' : 'c-local', direct: true },
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
    const out = await issuer.issue({ kind: 'pty', sessionId: 't:t' }, local)
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
    const out = await issuer.issue({ kind: 'chat', tabId: 'tab-1' }, local)
    expect(out.available).toBe(true)
    expect(requests[0]?.params.resource).toEqual({ kind: 'chat', tabId: 'tab-1', epoch: 4 })
    expect(gated[0]).toEqual({ computerId: 'c-local', work: { kind: 'task', id: 'task-1' } })
  })

  it('audits each issue with grant id, computer and resource — never the token', async () => {
    const { issuer } = setup()
    const out = await issuer.issue({ kind: 'pty', sessionId: 't:t' }, local)
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
    expect(await issuer.issue({ kind: 'pty', sessionId: 't:t' }, remoteClient)).toEqual({
      available: false,
      reason: 'unreachable'
    })
    const { issuer: other } = setup({}, [
      { computerId: 'c-local', directAddress: '127.0.0.1:5001', peerLoopback: false }
    ])
    expect(await other.issue({ kind: 'pty', sessionId: 't:t' }, local)).toEqual({
      available: false,
      reason: 'unreachable'
    })
    expect(requests).toEqual([])
  })

  it('offers a public address to any client', async () => {
    const { issuer } = setup()
    expect(await issuer.issue({ kind: 'pty', sessionId: 'r1' }, remoteClient)).toMatchObject({
      available: true,
      address: 'box.example:7443'
    })
  })

  it('answers unavailable, never an error, when there is nothing direct to offer', async () => {
    const { issuer } = setup()
    expect(await issuer.issue({ kind: 'pty', sessionId: 'gone' }, local)).toEqual({
      available: false,
      reason: 'no-computer'
    })
    expect(await issuer.issue({ kind: 'chat', tabId: 'gone' }, local)).toEqual({
      available: false,
      reason: 'no-computer'
    })
    expect(await issuer.issue({ kind: 'pty', sessionId: 'hub-owned' }, local)).toEqual({
      available: false,
      reason: 'not-direct'
    })
    const { issuer: none } = setup({}, [
      { computerId: 'c-local', directAddress: null, peerLoopback: true }
    ])
    expect(await none.issue({ kind: 'pty', sessionId: 't:t' }, local)).toEqual({
      available: false,
      reason: 'no-address'
    })
    const { issuer: offline } = setup({}, [])
    expect(await offline.issue({ kind: 'pty', sessionId: 't:t' }, local)).toEqual({
      available: false,
      reason: 'no-computer'
    })
  })

  it('refuses when the placement gate refuses, and registers nothing', async () => {
    const { issuer, requests } = setup({
      gate: async () => {
        throw new Error('not your computer')
      }
    })
    await expect(issuer.issue({ kind: 'pty', sessionId: 't:t' }, local)).rejects.toThrow(
      /not your computer/
    )
    expect(requests).toEqual([])
  })

  it('remembers what it issued per computer (for reset and revocation)', async () => {
    const { issuer } = setup()
    const a = await issuer.issue({ kind: 'pty', sessionId: 't:t' }, local)
    const b = await issuer.issue({ kind: 'pty', sessionId: 'r1' }, remoteClient)
    if (!a.available || !b.available) throw new Error('unreachable')
    expect(issuer.heldGrantIds('c-local')).toEqual([a.grantId])
    expect(issuer.heldGrantIds('c-remote')).toEqual([b.grantId])
  })

  it('forgets a grant once its TTL has passed', async () => {
    let now = 0
    const { issuer } = setup({ now: () => now })
    await issuer.issue({ kind: 'pty', sessionId: 't:t' }, local)
    now += DIRECT_GRANT_TTL_MS
    expect(issuer.heldGrantIds('c-local')).toEqual([])
  })
})
