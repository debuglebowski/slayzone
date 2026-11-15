/**
 * The detach controller on its own: explicit membership, the bounded record of
 * attempts the hub gave up on, and the warning when a computer runs sessions of a
 * kind nothing here tracks. The pty / proc behaviour on top of it is pinned in
 * exec-proxies.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const diagnostics = vi.hoisted(
  () => [] as Array<{ level: string; event: string; payload?: Record<string, unknown> }>
)
vi.mock('@slayzone/diagnostics/server', () => ({
  recordDiagnosticEvent: (event: (typeof diagnostics)[number]) => {
    diagnostics.push(event)
  }
}))

import { TypedEventEmitter } from '../shared/events'
import {
  ABANDONED_MAX_PER_COMPUTER,
  ABANDONED_TTL_MS,
  detachControllerStats,
  joinDetachController,
  toSessionList,
  type DetachableEntry,
  type DetachControllerOptions,
  type ListedSession
} from './detach-controller'
import type { ComputerDescriptor, ComputerGatewayEvents } from './hub-gateway'

class Gateway {
  readonly events = new TypedEventEmitter<ComputerGatewayEvents>()
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = []
  listed: Array<{ sessionId: string; spawnId?: string }> = []
  request<T>(_computerId: string, method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params: (params ?? {}) as Record<string, unknown> })
    if (method === 'x.list') return Promise.resolve({ sessions: this.listed, exited: [] } as T)
    return Promise.resolve(undefined as T)
  }
  listComputers(): ComputerDescriptor[] {
    return []
  }
  kills(): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.method === 'x.kill').map((c) => c.params)
  }
  lists(): number {
    return this.calls.filter((c) => c.method === 'x.list').length
  }
  connect(epoch: string): void {
    this.events.emit('computer-connected', {
      computer: {
        computerId: 'computer-1',
        authMode: 'hello',
        directAddress: null,
        peerLoopback: false,
        directRtc: false,
        connectedAt: 0,
        lastSeenAt: 0,
        epoch
      }
    })
  }
  async blip(epoch = 'epoch-a'): Promise<void> {
    const before = this.lists()
    this.events.emit('computer-lost', { computerId: 'computer-1', reason: 'heartbeat-timeout' })
    this.connect(epoch)
    if (epoch === 'epoch-a') await vi.waitFor(() => expect(this.lists()).toBe(before + 1))
    await tick()
    await tick()
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function join(
  gateway: Gateway,
  sessions = new Map<string, DetachableEntry>(),
  extra: Partial<DetachControllerOptions<DetachableEntry>> = {}
) {
  const membership = joinDetachController({
    ...extra,
    gateway,
    sessions,
    kind: 'test',
    listMethod: 'x.list',
    killMethod: 'x.kill',
    parseList: (raw) => toSessionList(raw as { sessions: Array<{ sessionId: string }> }),
    finalize: (entry) => {
      entry.disposed = true
      sessions.delete(entry.sessionId)
    },
    resume: (entry) => {
      entry.detached = false
    },
    settleExited: (entry) => {
      entry.disposed = true
    }
  })
  return { membership, sessions }
}

const entry = (sessionId: string, spawnId = `${sessionId}-a`): DetachableEntry => ({
  computerId: 'computer-1',
  sessionId,
  spawnId,
  disposed: false,
  detached: false
})

beforeEach(() => {
  diagnostics.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})

describe('membership is explicit', () => {
  it('join/leave cycles leave no participant behind', () => {
    const gateway = new Gateway()
    for (let i = 0; i < 500; i++) join(gateway).membership.leave()
    expect(detachControllerStats(gateway)).toEqual([
      { kind: 'test', participants: 0, abandonedRecords: 0 }
    ])
  })

  it('an emptied session map does NOT end membership (the 2026-11-14 crash)', async () => {
    const gateway = new Gateway()
    const { sessions } = join(gateway)
    gateway.connect('epoch-a')
    sessions.set('a', entry('a'))
    gateway.listed = [{ sessionId: 'a', spawnId: 'a-a' }]
    await gateway.blip()
    sessions.clear()
    gateway.listed = []
    await gateway.blip()
    expect(detachControllerStats(gateway)[0]?.participants).toBe(1)
  })

  it('leave() is idempotent and counts the owner’s live sessions as given up on', async () => {
    const gateway = new Gateway()
    join(gateway) // a long-lived participant stays
    const leaving = join(gateway)
    leaving.sessions.set('a', entry('a'))
    gateway.connect('epoch-a')
    leaving.membership.leave()
    leaving.membership.leave()
    expect(detachControllerStats(gateway)[0]).toMatchObject({
      participants: 1,
      abandonedRecords: 1
    })

    gateway.listed = [{ sessionId: 'a', spawnId: 'a-a' }]
    await gateway.blip()
    expect(gateway.kills()).toEqual([{ sessionId: 'a', spawnId: 'a-a' }])
    expect(diagnostics.find((d) => d.event === 'computer.strays_killed')?.payload).toMatchObject({
      reasons: { a: 'owner-left' }
    })
  })
})

describe('a computer running sessions no participant tracks', () => {
  it('warns and kills nothing', async () => {
    const gateway = new Gateway()
    join(gateway).membership.leave()
    gateway.connect('epoch-a')
    gateway.listed = [{ sessionId: 'a' }, { sessionId: 'b' }]
    await gateway.blip()
    expect(gateway.kills()).toEqual([])
    expect(diagnostics.find((d) => d.event === 'computer.sessions_unowned')).toMatchObject({
      level: 'warn',
      payload: { computerId: 'computer-1', kind: 'test', sessionIds: ['a', 'b'] }
    })
  })
})

describe('the record of abandoned attempts stays bounded', () => {
  it('drops an attempt the computer no longer lists', async () => {
    const gateway = new Gateway()
    const { membership } = join(gateway)
    gateway.connect('epoch-a')
    membership.abandon(entry('a'), 'closed-while-detached')
    gateway.listed = []
    await gateway.blip()
    expect(detachControllerStats(gateway)[0]?.abandonedRecords).toBe(0)
  })

  it('drops an attempt the computer replaced with another under the same id', async () => {
    const gateway = new Gateway()
    const { membership } = join(gateway)
    gateway.connect('epoch-a')
    membership.abandon(entry('a', 'old'), 'closed-while-detached')
    gateway.listed = [{ sessionId: 'a', spawnId: 'new' }]
    await gateway.blip()
    expect(gateway.kills()).toEqual([])
    expect(detachControllerStats(gateway)[0]?.abandonedRecords).toBe(0)
  })

  it('forgets everything when the computer comes back as a different process', async () => {
    const gateway = new Gateway()
    const { membership } = join(gateway)
    gateway.connect('epoch-a')
    membership.abandon(entry('a'), 'closed-while-detached')
    gateway.listed = [{ sessionId: 'a', spawnId: 'a-a' }]
    await gateway.blip('epoch-b')
    expect(detachControllerStats(gateway)[0]?.abandonedRecords).toBe(0)
    await gateway.blip('epoch-b')
    await vi.waitFor(() => expect(gateway.lists()).toBeGreaterThan(0))
    expect(gateway.kills()).toEqual([])
  })

  it('expires a record past its TTL: the session is then kept, not killed on stale evidence', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const gateway = new Gateway()
    const { membership } = join(gateway)
    gateway.connect('epoch-a')
    membership.abandon(entry('a'), 'closed-while-detached')
    vi.advanceTimersByTime(ABANDONED_TTL_MS + 1)
    gateway.listed = [{ sessionId: 'a', spawnId: 'a-a' }]
    await gateway.blip()
    expect(gateway.kills()).toEqual([])
    expect(detachControllerStats(gateway)[0]?.abandonedRecords).toBe(0)
  })

  it('caps the records per computer, oldest first', () => {
    const gateway = new Gateway()
    const { membership } = join(gateway)
    for (let i = 0; i < ABANDONED_MAX_PER_COMPUTER + 25; i++) {
      membership.abandon(entry(`s${String(i)}`), 'closed-while-detached')
    }
    expect(detachControllerStats(gateway)[0]?.abandonedRecords).toBe(ABANDONED_MAX_PER_COMPUTER)
  })
})

// ── A previous hub run's sessions: offered for adoption, never killed for it ──────
//
// A hub restart leaves the computer running sessions no participant tracks. They are
// kept (unknown is no kill reason) AND handed to the participants that can adopt
// them (`onUntracked`), so a restart is invisible to the agents.

describe('untracked sessions are offered to the participants', () => {
  type Offer = Array<{ sessionId: string; spawnId?: string }>
  const offers = () => {
    const seen: Offer[] = []
    const onUntracked = (
      _computerId: string,
      _epoch: string | undefined,
      kept: Array<{ sessionId: string; listed: ListedSession }>
    ) => {
      seen.push(kept.map((k) => ({ sessionId: k.sessionId, spawnId: k.listed.spawnId })))
    }
    return { seen, onUntracked }
  }

  it('first contact and every same-epoch reconnect offer exactly the kept sessions', async () => {
    const gateway = new Gateway()
    const { seen, onUntracked } = offers()
    const { sessions } = join(gateway, undefined, { onUntracked })
    gateway.listed = [{ sessionId: 'old', spawnId: 'run-1' }]
    gateway.connect('epoch-a')
    await vi.waitFor(() => expect(seen.at(-1)).toEqual([{ sessionId: 'old', spawnId: 'run-1' }]))

    // One the hub tracks itself is never offered; an emptied list clears the offer.
    sessions.set('mine', entry('mine'))
    gateway.listed = [{ sessionId: 'mine', spawnId: 'mine-a' }]
    await gateway.blip()
    expect(seen.at(-1)).toEqual([])
    expect(gateway.kills()).toEqual([])
  })

  it('an attempt the hub recorded giving up on is killed, not offered', async () => {
    const gateway = new Gateway()
    const { seen, onUntracked } = offers()
    const { membership } = join(gateway, undefined, { onUntracked })
    gateway.connect('epoch-a')
    await vi.waitFor(() => expect(seen.at(-1)).toEqual([]))
    membership.abandon(entry('a'), 'closed-while-detached')
    gateway.listed = [{ sessionId: 'a', spawnId: 'a-a' }]
    await gateway.blip()
    expect(gateway.kills()).toEqual([{ sessionId: 'a', spawnId: 'a-a' }])
    expect(seen.at(-1)).toEqual([])
  })

  it('a computer back as a different process withdraws the offer', async () => {
    const gateway = new Gateway()
    const { seen, onUntracked } = offers()
    join(gateway, undefined, { onUntracked })
    gateway.listed = [{ sessionId: 'old', spawnId: 'run-1' }]
    gateway.connect('epoch-a')
    await vi.waitFor(() => expect(seen.at(-1)).toEqual([{ sessionId: 'old', spawnId: 'run-1' }]))
    await gateway.blip('epoch-b')
    await vi.waitFor(() => expect(seen.at(-1)).toEqual([]))
  })
})
