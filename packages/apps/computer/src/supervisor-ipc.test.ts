import { HubDialer, type ComputerCredentialStore } from '@slayzone/computer-transport/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSupervisorIpc,
  type ChildToParentMessage,
  type SupervisorIpcOptions
} from './supervisor-ipc'

const PRIMARY = 'ws://127.0.0.1:4100/computers'
const B = 'wss://hub.example.com/computers'

function memoryStore(): ComputerCredentialStore {
  return {
    load: async () => null,
    save: async () => {},
    clear: async () => {},
    filePath: '/dev/null'
  }
}

/** A dialer that is never started: its lifecycle is driven by emitting events. */
function dialer(url: string): HubDialer {
  return new HubDialer({
    url,
    identity: { name: 'n', platform: 'p', version: 'v', capabilities: [] },
    credentialStore: memoryStore()
  })
}

function harness(options: Partial<SupervisorIpcOptions> = {}) {
  const sent: ChildToParentMessage[] = []
  let connected = true
  const ipc = createSupervisorIpc({
    send: (message) => {
      if (!connected) return false
      sent.push(message)
      return true
    },
    newRequestId: (() => {
      let n = 0
      return () => `req-${++n}`
    })(),
    ...options
  })
  return { ipc, sent, disconnect: () => (connected = false) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('supervisor IPC: hub reports', () => {
  it('reports connected (with computer id) and disconnected for the primary', () => {
    const { ipc, sent } = harness()
    const d = dialer(PRIMARY)
    ipc.reportConnection({ hubUrl: PRIMARY, primary: true, dialer: d })
    d.events.emit('connected', { computerId: 'c-1', mode: 'hello' })
    d.events.emit('disconnected', { reason: 'gone' })
    // A primary's fatal is the exit code's business, never a hub-error.
    d.events.emit('error', { error: new Error('x'), fatal: true, reason: 'needs-re-enrollment' })
    expect(sent).toEqual([
      { type: 'connected', hubUrl: PRIMARY, computerId: 'c-1', primary: true },
      { type: 'disconnected', hubUrl: PRIMARY, primary: true }
    ])
  })

  it('reports a secondary hub fatal as hub-error, carrying the re-enrollment reason', () => {
    const { ipc, sent } = harness()
    const d = dialer(B)
    ipc.reportConnection({ hubUrl: B, primary: false, dialer: d })
    d.events.emit('connected', { computerId: 'c-2', mode: 'enroll' })
    // Non-fatal errors are the dialer retrying: nothing for the parent to act on.
    d.events.emit('error', { error: new Error('blip'), fatal: false })
    d.events.emit('error', {
      error: new Error('spent'),
      fatal: true,
      reason: 'needs-re-enrollment'
    })
    d.events.emit('error', { error: new Error('other'), fatal: true })
    expect(sent).toEqual([
      { type: 'connected', hubUrl: B, computerId: 'c-2', primary: false },
      {
        type: 'hub-error',
        hubUrl: B,
        primary: false,
        message: 'spent',
        reason: 'needs-re-enrollment'
      },
      { type: 'hub-error', hubUrl: B, primary: false, message: 'other' }
    ])
  })

  it('announces readiness for set-hubs', () => {
    const { ipc, sent } = harness()
    ipc.ready()
    expect(sent).toEqual([{ type: 'hubs-ready' }])
  })
})

describe('supervisor IPC: join tokens', () => {
  it('asks the parent and resolves with its reply', async () => {
    const { ipc, sent } = harness()
    const pending = ipc.requestJoinToken(B)
    expect(sent).toEqual([{ type: 'join-token-request', requestId: 'req-1', hubUrl: B }])
    // Unknown request ids and malformed replies are ignored.
    ipc.handleMessage({ type: 'join-token', requestId: 'req-9', token: 'wrong' }, {})
    ipc.handleMessage({ type: 'join-token', requestId: 'req-1', token: 42 }, {})
    ipc.handleMessage({ type: 'join-token', requestId: 'req-1', token: 'tok' }, {})
    await expect(pending).resolves.toBe('tok')
  })

  it('resolves null when the parent cannot mint one', async () => {
    const { ipc } = harness()
    const pending = ipc.requestJoinToken(B)
    ipc.handleMessage({ type: 'join-token', requestId: 'req-1', token: null }, {})
    await expect(pending).resolves.toBeNull()
  })

  it('resolves null after the timeout', async () => {
    vi.useFakeTimers()
    const { ipc } = harness({ joinTokenTimeoutMs: 60_000 })
    const pending = ipc.requestJoinToken(B)
    vi.advanceTimersByTime(59_999)
    let settled = false
    void pending.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    vi.advanceTimersByTime(1)
    await expect(pending).resolves.toBeNull()
  })

  it('resolves null at once when the parent is unreachable, and on dispose', async () => {
    const { ipc, disconnect } = harness()
    const before = ipc.requestJoinToken(B)
    ipc.dispose()
    await expect(before).resolves.toBeNull()
    disconnect()
    await expect(ipc.requestJoinToken(B)).resolves.toBeNull()
  })
})

describe('supervisor IPC: set-hubs', () => {
  it('applies a well-formed set-hubs', () => {
    const { ipc } = harness()
    const setSecondaryHubs = vi.fn()
    const hubs = [
      { url: B, name: 'Kalle', joinToken: 'tok' },
      { url: 'ws://localhost:9/computers', name: 'x' }
    ]
    ipc.handleMessage({ type: 'set-hubs', hubs }, { setSecondaryHubs })
    expect(setSecondaryHubs).toHaveBeenCalledWith(hubs)
    ipc.handleMessage({ type: 'set-hubs', hubs: [] }, { setSecondaryHubs })
    expect(setSecondaryHubs).toHaveBeenLastCalledWith([])
  })

  it.each([
    null,
    'set-hubs',
    { type: 'set-hubs' },
    { type: 'set-hubs', hubs: 'nope' },
    { type: 'set-hubs', hubs: [{ url: B }] },
    { type: 'set-hubs', hubs: [{ url: B, name: '' }] },
    { type: 'set-hubs', hubs: [{ url: 'https://hub.example.com', name: 'x' }] },
    { type: 'set-hubs', hubs: [{ url: 'not a url', name: 'x' }] },
    { type: 'set-hubs', hubs: [{ url: B, name: 'x', joinToken: 7 }] },
    { type: 'something-else' }
  ])('ignores a malformed message: %j', (raw) => {
    const { ipc } = harness()
    const setSecondaryHubs = vi.fn()
    expect(() => ipc.handleMessage(raw, { setSecondaryHubs })).not.toThrow()
    expect(setSecondaryHubs).not.toHaveBeenCalled()
  })
})
