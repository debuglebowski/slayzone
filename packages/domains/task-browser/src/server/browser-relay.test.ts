/**
 * BrowserRelay — the hub's registry of which client owns which task's browser tabs,
 * and the request/reply channel `slay browser` rides to reach that client.
 */
import { test, expect, vi } from 'vitest'
import type { BrowserRelayFrame } from '../shared'
import { BrowserRelay } from './browser-relay'

function host(relay: BrowserRelay, taskId: string, principal: string | null = null) {
  const frames: BrowserRelayFrame[] = []
  const h = relay.attachHost({ taskId, principalKey: principal, send: (f) => frames.push(f) })
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
  const p = relay.run('t1', null, { op: 'execJs', code: '1+1' })
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
  const p = relay.run('t1', 'x', { op: 'getUrl' })
  const [req] = a.requests()
  relay.reply(null, { hostId: a.hostId, requestId: req.requestId, ok: false, error: 'boom' })
  await expect(p).rejects.toThrow('boom')
})

test('two clients on one task: the most recently synced one owns it', async () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  const b = host(relay, 't1')
  relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  relay.sync(null, { hostId: b.hostId, tabIds: ['x'], activeTabId: 'x' })
  void relay.run('t1', null, { op: 'getUrl' })
  expect(a.requests()).toHaveLength(0)
  expect(b.requests()).toHaveLength(1)
  // A is used again → it owns the task now.
  relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  void relay.run('t1', null, { op: 'getUrl' })
  expect(a.requests()).toHaveLength(1)
})

test('an explicit tab goes to the host that has it, even if another was used later', () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  const b = host(relay, 't1')
  relay.sync(null, { hostId: a.hostId, tabIds: ['only-a'], activeTabId: 'only-a' })
  relay.sync(null, { hostId: b.hostId, tabIds: ['only-b'], activeTabId: 'only-b' })
  void relay.run('t1', 'only-a', { op: 'getUrl' })
  expect(a.requests()).toHaveLength(1)
  expect(b.requests()).toHaveLength(0)
})

test('run with no owner rejects', async () => {
  const relay = new BrowserRelay()
  await expect(relay.run('t1', null, { op: 'getUrl' })).rejects.toThrow(/not available/)
})

test('detach drops the host tabs and rejects its in-flight requests', async () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  const p = relay.run('t1', null, { op: 'getUrl' })
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
    const p = relay.run('t1', null, { op: 'getUrl' })
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
  expect(relay.taskOf('alice', a.hostId)).toBe('t1')
  expect(() => relay.taskOf('bob', a.hostId)).toThrow(/Unknown browser host/)
})

test('a reply from another principal cannot settle the request', async () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1', 'alice')
  relay.sync('alice', { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  const p = relay.run('t1', null, { op: 'getUrl' })
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
