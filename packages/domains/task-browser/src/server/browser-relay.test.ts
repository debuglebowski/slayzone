/**
 * BrowserRelay — the hub's registry of which client owns which task's browser tabs,
 * and the request/reply channel `slay browser` rides to reach that client.
 */
import { test, expect, vi } from 'vitest'
import type { BrowserRelayFrame } from '../shared'
import { BrowserRelay } from './browser-relay'

function host(
  relay: BrowserRelay,
  taskId: string,
  principal: string | null = null,
  clientKey = `client-${Math.random()}`
) {
  const frames: BrowserRelayFrame[] = []
  const h = relay.attachHost({
    taskId,
    principalKey: principal,
    clientKey,
    send: (f) => frames.push(f)
  })
  const requests = () =>
    frames.filter((f): f is Extract<BrowserRelayFrame, { type: 'request' }> => f.type === 'request')
  return { ...h, frames, requests }
}

test('attach greets the host with its id', () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  expect(a.frames).toEqual([{ type: 'hello', hostId: a.hostId }])
})

test('no host → no tab; sync registers tabs and the active one', () => {
  const relay = new BrowserRelay()
  expect(relay.hasTab('t1')).toBe(false)
  const a = host(relay, 't1')
  expect(relay.hasTab('t1')).toBe(false)
  relay.sync(null, { hostId: a.hostId, tabIds: ['x', 'y'], activeTabId: 'y' })
  expect(relay.hasTab('t1')).toBe(true)
  expect(relay.hasTab('t1', 'x')).toBe(true)
  expect(relay.hasTab('t1', 'z')).toBe(false)
  expect(relay.getResolvedTabId('t1')).toBe('y')
  expect(relay.getResolvedTabId('t1', 'x')).toBe('x')
  expect(relay.listTabs('t1')).toEqual([
    { tabId: 'x', active: false },
    { tabId: 'y', active: true }
  ])
  expect(relay.hasTab('t2')).toBe(false)
})

test('active tab that is not registered does not count as an open panel', () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  relay.sync(null, { hostId: a.hostId, tabIds: [], activeTabId: 'y' })
  expect(relay.hasTab('t1')).toBe(false)
})

test('run sends the op to the owning host and resolves with its reply', async () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  const p = relay.run('t1', null, { op: 'execJs', code: '1+1' }, 'elsewhere')
  const [req] = a.requests()
  expect(req).toMatchObject({
    type: 'request',
    taskId: 't1',
    tabId: 'x',
    op: 'execJs',
    code: '1+1'
  })
  relay.reply(null, { hostId: a.hostId, requestId: req.requestId, ok: true, result: 2 })
  await expect(p).resolves.toBe(2)
})

test('error replies reject with the client message', async () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  const p = relay.run('t1', 'x', { op: 'getUrl' }, 'elsewhere')
  const [req] = a.requests()
  relay.reply(null, { hostId: a.hostId, requestId: req.requestId, ok: false, error: 'boom' })
  await expect(p).rejects.toThrow('boom')
})

test('two clients on one task: the first to serve owns it until another is used', () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1', null, 'desk-a')
  const b = host(relay, 't1', null, 'desk-b')
  relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  relay.sync(null, { hostId: b.hostId, tabIds: ['x'], activeTabId: 'x' })
  // Mounting / syncing is not use: A (first) still owns it.
  void relay.run('t1', null, { op: 'getUrl' }, 'elsewhere')
  expect(a.requests()).toHaveLength(1)
  expect(b.requests()).toHaveLength(0)
  // B is used → B owns it.
  relay.noteUse(null, 'desk-b', 't1')
  void relay.run('t1', null, { op: 'getUrl' }, 'elsewhere')
  expect(b.requests()).toHaveLength(1)
  // A is used again → A owns it.
  relay.noteUse(null, 'desk-a', 't1')
  void relay.run('t1', null, { op: 'getUrl' }, 'elsewhere')
  expect(a.requests()).toHaveLength(2)
})

test('a reconnect (new host, same client) re-syncing does not steal ownership', () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1', null, 'desk-a')
  const b1 = host(relay, 't1', null, 'desk-b')
  relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  relay.sync(null, { hostId: b1.hostId, tabIds: ['x'], activeTabId: 'x' })
  relay.noteUse(null, 'desk-a', 't1')
  // B's socket drops and comes back: a fresh host id, a full re-sync, repeatedly.
  b1.detach()
  const b2 = host(relay, 't1', null, 'desk-b')
  relay.sync(null, { hostId: b2.hostId, tabIds: ['x'], activeTabId: 'x' })
  relay.sync(null, { hostId: b2.hostId, tabIds: ['x', 'y'], activeTabId: 'y' })
  void relay.run('t1', null, { op: 'getUrl' }, 'elsewhere')
  expect(a.requests()).toHaveLength(1)
  expect(b2.requests()).toHaveLength(0)
})

test('use earlier than a reconnect still counts for that client', () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1', null, 'desk-a')
  relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  const b1 = host(relay, 't1', null, 'desk-b')
  relay.sync(null, { hostId: b1.hostId, tabIds: ['x'], activeTabId: 'x' })
  relay.noteUse(null, 'desk-b', 't1')
  b1.detach()
  const b2 = host(relay, 't1', null, 'desk-b')
  relay.sync(null, { hostId: b2.hostId, tabIds: ['x'], activeTabId: 'x' })
  void relay.run('t1', null, { op: 'getUrl' }, 'elsewhere')
  expect(b2.requests()).toHaveLength(1)
  expect(a.requests()).toHaveLength(0)
})

test('use is per principal: another user using the same client key wins nothing', () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1', 'alice', 'desk-a')
  const b = host(relay, 't1', 'alice', 'desk-b')
  relay.sync('alice', { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  relay.sync('alice', { hostId: b.hostId, tabIds: ['x'], activeTabId: 'x' })
  relay.noteUse('bob', 'desk-b', 't1')
  void relay.run('t1', null, { op: 'getUrl' }, 'elsewhere')
  expect(a.requests()).toHaveLength(1)
})

test('the request carries the hub-side origin of the caller', () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  void relay.run('t1', null, { op: 'getUrl' }, 'hub-machine')
  void relay.run('t1', null, { op: 'getUrl' }, 'elsewhere')
  expect(a.requests().map((r) => r.origin)).toEqual(['hub-machine', 'elsewhere'])
})

test('a reply over the size cap fails the request, not the hub', async () => {
  const relay = new BrowserRelay({ maxResultBytes: 1000 })
  const a = host(relay, 't1')
  relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  const p = relay.run('t1', null, { op: 'execJs', code: 'big' }, 'elsewhere')
  const [req] = a.requests()
  expect(() =>
    relay.reply(null, {
      hostId: a.hostId,
      requestId: req.requestId,
      ok: true,
      result: 'x'.repeat(5000)
    })
  ).toThrow(/too large/)
  await expect(p).rejects.toThrow(/too large/)
})

test('an explicit tab goes to the host that has it, even if another was used later', () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  const b = host(relay, 't1')
  relay.sync(null, { hostId: a.hostId, tabIds: ['only-a'], activeTabId: 'only-a' })
  relay.sync(null, { hostId: b.hostId, tabIds: ['only-b'], activeTabId: 'only-b' })
  void relay.run('t1', 'only-a', { op: 'getUrl' }, 'elsewhere')
  expect(a.requests()).toHaveLength(1)
  expect(b.requests()).toHaveLength(0)
})

test('run with no owner rejects', async () => {
  const relay = new BrowserRelay()
  await expect(relay.run('t1', null, { op: 'getUrl' }, 'elsewhere')).rejects.toThrow(
    /not available/
  )
})

test('detach drops the host tabs and rejects its in-flight requests', async () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  const p = relay.run('t1', null, { op: 'getUrl' }, 'elsewhere')
  a.detach()
  await expect(p).rejects.toThrow(/closed/)
  expect(relay.hasTab('t1')).toBe(false)
})

test('a request the client never answers times out', async () => {
  vi.useFakeTimers()
  try {
    const relay = new BrowserRelay({ requestTimeoutMs: 1000 })
    const a = host(relay, 't1')
    relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
    const p = relay.run('t1', null, { op: 'getUrl' }, 'elsewhere')
    const assertion = expect(p).rejects.toThrow(/did not answer/)
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
  } finally {
    vi.useRealTimers()
  }
})

test('waitForRegistration resolves when a matching tab syncs, rejects on timeout', async () => {
  vi.useFakeTimers()
  try {
    const relay = new BrowserRelay()
    const a = host(relay, 't1')
    const waitAny = relay.waitForRegistration('t1', { timeoutMs: 5000 })
    const waitTab = relay.waitForRegistration('t1', { tabId: 'later', timeoutMs: 5000 })
    relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
    await expect(waitAny).resolves.toBeUndefined()
    const tabAssertion = expect(waitTab).rejects.toThrow(/did not open/)
    await vi.advanceTimersByTimeAsync(5001)
    await tabAssertion
    // Already registered → resolves at once.
    await expect(relay.waitForRegistration('t1', { tabId: 'x' })).resolves.toBeUndefined()
  } finally {
    vi.useRealTimers()
  }
})

test('a host is bound to the principal that opened it', () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1', 'alice')
  expect(() => relay.sync('bob', { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })).toThrow(
    /Unknown browser host/
  )
  expect(() => relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })).toThrow(
    /Unknown browser host/
  )
  relay.sync('alice', { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  expect(relay.hasTab('t1')).toBe(true)
})

test('a reply from another principal cannot settle the request', async () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1', 'alice')
  relay.sync('alice', { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  const p = relay.run('t1', null, { op: 'getUrl' }, 'elsewhere')
  const [req] = a.requests()
  expect(() =>
    relay.reply('bob', { hostId: a.hostId, requestId: req.requestId, ok: true, result: 'evil' })
  ).toThrow(/Unknown browser host/)
  relay.reply('alice', { hostId: a.hostId, requestId: req.requestId, ok: true, result: 'ok' })
  await expect(p).resolves.toBe('ok')
})

test('a stale reply (unknown request id) is ignored', () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  expect(() =>
    relay.reply(null, { hostId: a.hostId, requestId: 'nope', ok: true, result: 1 })
  ).not.toThrow()
})
