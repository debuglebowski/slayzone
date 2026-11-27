/**
 * BrowserRelay — the hub's registry of which client owns which task's browser tabs,
 * and the request/reply channel `slay browser` rides to reach that client.
 */
import { test, expect, vi } from 'vitest'
import type { BrowserRelayFrame } from '../shared'
import { BrowserRelay } from './browser-relay'
import { BROWSER_RELAY_OP_DEADLINE_MS } from '../shared'

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
  expect(relay.hasTab(null, 't1')).toBe(false)
  const a = host(relay, 't1')
  expect(relay.hasTab(null, 't1')).toBe(false)
  relay.sync(null, { hostId: a.hostId, tabIds: ['x', 'y'], activeTabId: 'y' })
  expect(relay.hasTab(null, 't1')).toBe(true)
  expect(relay.hasTab(null, 't1', 'x')).toBe(true)
  expect(relay.hasTab(null, 't1', 'z')).toBe(false)
  expect(relay.getResolvedTabId(null, 't1')).toBe('y')
  expect(relay.getResolvedTabId(null, 't1', 'x')).toBe('x')
  expect(relay.listTabs(null, 't1')).toEqual([
    { tabId: 'x', active: false, isolated: false },
    { tabId: 'y', active: true, isolated: false }
  ])
  expect(relay.hasTab(null, 't2')).toBe(false)
})

test('active tab that is not registered does not count as an open panel', () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  relay.sync(null, { hostId: a.hostId, tabIds: [], activeTabId: 'y' })
  expect(relay.hasTab(null, 't1')).toBe(false)
})

test('run sends the op to the owning host and resolves with its reply', async () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  const p = relay.run(null, 't1', null, { op: 'execJs', code: '1+1' }, 'elsewhere')
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
  const p = relay.run(null, 't1', 'x', { op: 'getUrl' }, 'elsewhere')
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
  void relay.run(null, 't1', null, { op: 'getUrl' }, 'elsewhere')
  expect(a.requests()).toHaveLength(1)
  expect(b.requests()).toHaveLength(0)
  // B is used → B owns it.
  relay.noteUse(null, 'desk-b', 't1')
  void relay.run(null, 't1', null, { op: 'getUrl' }, 'elsewhere')
  expect(b.requests()).toHaveLength(1)
  // A is used again → A owns it.
  relay.noteUse(null, 'desk-a', 't1')
  void relay.run(null, 't1', null, { op: 'getUrl' }, 'elsewhere')
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
  void relay.run(null, 't1', null, { op: 'getUrl' }, 'elsewhere')
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
  void relay.run(null, 't1', null, { op: 'getUrl' }, 'elsewhere')
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
  void relay.run('alice', 't1', null, { op: 'getUrl' }, 'elsewhere')
  expect(a.requests()).toHaveLength(1)
})

test('the request carries the hub-side origin of the caller', () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  void relay.run(null, 't1', null, { op: 'getUrl' }, 'hub-machine')
  void relay.run(null, 't1', null, { op: 'getUrl' }, 'elsewhere')
  expect(a.requests().map((r) => r.origin)).toEqual(['hub-machine', 'elsewhere'])
})

test('a reply over the size cap fails the request, not the hub', async () => {
  const relay = new BrowserRelay({ maxResultBytes: 1000 })
  const a = host(relay, 't1')
  relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  const p = relay.run(null, 't1', null, { op: 'execJs', code: 'big' }, 'elsewhere')
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
  void relay.run(null, 't1', 'only-a', { op: 'getUrl' }, 'elsewhere')
  expect(a.requests()).toHaveLength(1)
  expect(b.requests()).toHaveLength(0)
})

test('several browser panels of a task on one client: the primary answers, until another panel is used', () => {
  const relay = new BrowserRelay()
  // The second instance mounted first (e.g. the primary was shown later).
  const second = host(relay, 't1', null, 'desk')
  const primary = host(relay, 't1', null, 'desk')
  relay.sync(null, { hostId: second.hostId, tabIds: ['b1'], activeTabId: 'b1', primary: false })
  relay.sync(null, { hostId: primary.hostId, tabIds: ['p1'], activeTabId: 'p1', primary: true })
  expect(relay.getResolvedTabId(null, 't1')).toBe('p1')
  // Using the second panel's own chrome makes it the target.
  relay.noteUse(null, 'desk', 't1', second.hostId)
  expect(relay.getResolvedTabId(null, 't1')).toBe('b1')
  // Plain client use (input in a web view) changes nothing between the panels.
  relay.noteUse(null, 'desk', 't1')
  expect(relay.getResolvedTabId(null, 't1')).toBe('b1')
  relay.noteUse(null, 'desk', 't1', primary.hostId)
  expect(relay.getResolvedTabId(null, 't1')).toBe('p1')
  // An explicit tab still goes to whichever panel has it.
  void relay.run(null, 't1', 'b1', { op: 'getUrl' }, 'hub-machine')
  expect(second.requests()).toHaveLength(1)
})

test('listTabs lists every browser panel’s tabs on the owning client', () => {
  const relay = new BrowserRelay()
  const primary = host(relay, 't1', null, 'desk')
  const second = host(relay, 't1', null, 'desk')
  const elsewhere = host(relay, 't1', null, 'laptop')
  relay.sync(null, { hostId: primary.hostId, tabIds: ['p1'], activeTabId: 'p1' })
  relay.sync(null, { hostId: second.hostId, tabIds: ['b1'], activeTabId: 'b1', primary: false })
  relay.sync(null, { hostId: elsewhere.hostId, tabIds: ['l1'], activeTabId: 'l1' })
  expect(relay.listTabs(null, 't1')).toEqual([
    { tabId: 'p1', active: true, isolated: false },
    { tabId: 'b1', active: false, isolated: false }
  ])
})

test('host-level use from another principal or task is ignored', () => {
  const relay = new BrowserRelay()
  const primary = host(relay, 't1', 'u1', 'desk')
  const second = host(relay, 't1', 'u1', 'desk')
  relay.sync('u1', { hostId: primary.hostId, tabIds: ['p1'], activeTabId: 'p1' })
  relay.sync('u1', { hostId: second.hostId, tabIds: ['b1'], activeTabId: 'b1', primary: false })
  relay.noteUse('u2', 'desk', 't1', second.hostId)
  relay.noteUse('u1', 'desk', 't2', second.hostId)
  expect(relay.getResolvedTabId('u1', 't1')).toBe('p1')
})

test('run with no owner rejects', async () => {
  const relay = new BrowserRelay()
  await expect(relay.run(null, 't1', null, { op: 'getUrl' }, 'elsewhere')).rejects.toThrow(
    /not available/
  )
})

test('detach drops the host tabs and rejects its in-flight requests', async () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  const p = relay.run(null, 't1', null, { op: 'getUrl' }, 'elsewhere')
  a.detach()
  await expect(p).rejects.toThrow(/closed/)
  expect(relay.hasTab(null, 't1')).toBe(false)
})

test('a request the client never answers times out', async () => {
  vi.useFakeTimers()
  try {
    const relay = new BrowserRelay({ requestTimeoutMs: 1000 })
    const a = host(relay, 't1')
    relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
    const p = relay.run(null, 't1', null, { op: 'getUrl' }, 'elsewhere')
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
    const waitAny = relay.waitForRegistration(null, 't1', { timeoutMs: 5000 })
    const waitTab = relay.waitForRegistration(null, 't1', { tabId: 'later', timeoutMs: 5000 })
    relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
    await expect(waitAny).resolves.toBeUndefined()
    const tabAssertion = expect(waitTab).rejects.toThrow(/did not open/)
    await vi.advanceTimersByTimeAsync(5001)
    await tabAssertion
    // Already registered → resolves at once.
    await expect(relay.waitForRegistration(null, 't1', { tabId: 'x' })).resolves.toBeUndefined()
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
  expect(relay.hasTab('alice', 't1')).toBe(true)
})

test('a reply from another principal cannot settle the request', async () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1', 'alice')
  relay.sync('alice', { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  const p = relay.run('alice', 't1', null, { op: 'getUrl' }, 'elsewhere')
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

test('a request that keeps reporting progress is not cut off by the timeout', async () => {
  vi.useFakeTimers()
  try {
    const relay = new BrowserRelay({ requestTimeoutMs: 1000 })
    const a = host(relay, 't1')
    relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
    const p = relay.run(null, 't1', null, { op: 'loadUrl', url: 'https://slow.test/' }, 'elsewhere')
    const [req] = a.requests()
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(800)
      relay.progress(null, { hostId: a.hostId, requestId: req.requestId })
    }
    relay.reply(null, { hostId: a.hostId, requestId: req.requestId, ok: true, result: null })
    await expect(p).resolves.toBeNull()
    // Silence still times out.
    const q = relay.run(null, 't1', null, { op: 'getUrl' }, 'elsewhere')
    const assertion = expect(q).rejects.toThrow(/did not answer/)
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
  } finally {
    vi.useRealTimers()
  }
})

test('progress from another principal is refused', () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1', 'alice')
  expect(() => relay.progress('bob', { hostId: a.hostId, requestId: 'r' })).toThrow(
    /Unknown browser host/
  )
})

test('a desktop app connected for a user, per principal', () => {
  const relay = new BrowserRelay()
  expect(relay.hasClient(null)).toBe(false)
  const off = relay.attachClient('alice')
  expect(relay.hasClient('alice')).toBe(true)
  expect(relay.hasClient('bob')).toBe(false)
  const off2 = relay.attachClient('alice')
  off()
  expect(relay.hasClient('alice')).toBe(true)
  off2()
  expect(relay.hasClient('alice')).toBe(false)
})

test('progress cannot keep a request alive past its op deadline; the host is told to stop', async () => {
  vi.useFakeTimers()
  try {
    const relay = new BrowserRelay({ requestTimeoutMs: 1000 })
    const a = host(relay, 't1')
    relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
    // An abandoned eval (`new Promise(() => {})`): the client keeps reporting progress.
    const p = relay.run(
      null,
      't1',
      null,
      { op: 'execJs', code: 'new Promise(() => {})' },
      'elsewhere'
    )
    const [req] = a.requests()
    const assertion = expect(p).rejects.toThrow(/did not finish/)
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(800)
      try {
        relay.progress(null, { hostId: a.hostId, requestId: req.requestId })
      } catch {
        /* settled */
      }
    }
    await assertion
    expect(a.frames).toContainEqual({ type: 'cancel', requestId: req.requestId })
  } finally {
    vi.useRealTimers()
  }
})

test('a silence timeout also tells the host to stop', async () => {
  vi.useFakeTimers()
  try {
    const relay = new BrowserRelay({ requestTimeoutMs: 1000 })
    const a = host(relay, 't1')
    relay.sync(null, { hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
    const p = relay.run(null, 't1', null, { op: 'getUrl' }, 'elsewhere')
    const [req] = a.requests()
    const assertion = expect(p).rejects.toThrow(/did not answer/)
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
    expect(a.frames).toContainEqual({ type: 'cancel', requestId: req.requestId })
  } finally {
    vi.useRealTimers()
  }
})

test('each op has an absolute deadline; a slow page load gets minutes', () => {
  expect(BROWSER_RELAY_OP_DEADLINE_MS.execJs).toBeLessThanOrEqual(30_000)
  expect(BROWSER_RELAY_OP_DEADLINE_MS.loadUrl).toBeGreaterThanOrEqual(120_000)
})

test('a request only ever reaches the REQUESTER’s own hosts (review 4: task sharing)', async () => {
  const relay = new BrowserRelay()
  const alice = host(relay, 't1', 'alice', 'desk-a')
  const bob = host(relay, 't1', 'bob', 'desk-b')
  relay.sync('alice', { hostId: alice.hostId, tabIds: ['x'], activeTabId: 'x' })
  relay.sync('bob', { hostId: bob.hostId, tabIds: ['x', 'y'], activeTabId: 'y' })
  relay.noteUse('bob', 'desk-b', 't1') // bob used it last
  void relay.run('alice', 't1', null, { op: 'getUrl' }, 'elsewhere')
  expect(alice.requests()).toHaveLength(1)
  expect(bob.requests()).toHaveLength(0)
  expect(relay.hasTab('alice', 't1', 'y')).toBe(false)
  expect(relay.listTabs('alice', 't1')).toEqual([{ tabId: 'x', active: true, isolated: false }])
  expect(relay.getResolvedTabId('alice', 't1')).toBe('x')
  expect(relay.hasTab('carol', 't1')).toBe(false)
  await expect(relay.run('carol', 't1', null, { op: 'getUrl' }, 'elsewhere')).rejects.toThrow(
    /not available/
  )
})

test('waiting for a tab only counts the requester’s own hosts', async () => {
  vi.useFakeTimers()
  try {
    const relay = new BrowserRelay()
    const bob = host(relay, 't1', 'bob')
    const wait = relay.waitForRegistration('alice', 't1', { timeoutMs: 1000 })
    relay.sync('bob', { hostId: bob.hostId, tabIds: ['x'], activeTabId: 'x' })
    const assertion = expect(wait).rejects.toThrow(/did not open/)
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
  } finally {
    vi.useRealTimers()
  }
})

test("an isolated scope (untrusted caller) never resolves to one of the user's own tabs", async () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  // The user's own tab is active; no isolated tab yet.
  relay.sync(null, { hostId: a.hostId, tabIds: ['own'], activeTabId: 'own' })
  expect(relay.hasTab(null, 't1', undefined, 'isolated')).toBe(false)
  expect(relay.hasTab(null, 't1', 'own', 'isolated')).toBe(false)
  expect(relay.getResolvedTabId(null, 't1', undefined, 'isolated')).toBeNull()
  expect(relay.isUsersOwnTab(null, 't1', 'own')).toBe(true)
  await expect(
    relay.run(null, 't1', null, { op: 'getUrl' }, 'elsewhere', 'isolated')
  ).rejects.toThrow(/not available/)
  await expect(
    relay.run(null, 't1', 'own', { op: 'getUrl' }, 'elsewhere', 'isolated')
  ).rejects.toThrow(/not available/)
  expect(a.requests()).toEqual([])

  // An isolated tab opens (not active): a no-id request goes to IT, not the active one.
  relay.sync(null, {
    hostId: a.hostId,
    tabIds: ['own', 'iso'],
    activeTabId: 'own',
    isolatedTabIds: ['iso']
  })
  expect(relay.getResolvedTabId(null, 't1', undefined, 'isolated')).toBe('iso')
  expect(relay.getResolvedTabId(null, 't1')).toBe('own')
  expect(relay.isUsersOwnTab(null, 't1', 'iso')).toBe(false)
  void relay.run(null, 't1', null, { op: 'getUrl' }, 'elsewhere', 'isolated').catch(() => {})
  expect(a.requests().at(-1)?.tabId).toBe('iso')
  expect(relay.listTabs(null, 't1')).toEqual([
    { tabId: 'own', active: true, isolated: false },
    { tabId: 'iso', active: false, isolated: true }
  ])
})

test('an isolated id the client did not report as a live tab is ignored', () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  relay.sync(null, {
    hostId: a.hostId,
    tabIds: ['own'],
    activeTabId: 'own',
    isolatedTabIds: ['ghost']
  })
  expect(relay.hasTab(null, 't1', undefined, 'isolated')).toBe(false)
})

test('waiting in the isolated scope settles only when an isolated tab registers', async () => {
  const relay = new BrowserRelay()
  const a = host(relay, 't1')
  let settled = false
  const wait = relay
    .waitForRegistration(null, 't1', { scope: 'isolated', timeoutMs: 1_000 })
    .then(() => (settled = true))
  relay.sync(null, { hostId: a.hostId, tabIds: ['own'], activeTabId: 'own' })
  await Promise.resolve()
  expect(settled).toBe(false)
  relay.sync(null, {
    hostId: a.hostId,
    tabIds: ['own', 'iso'],
    activeTabId: 'own',
    isolatedTabIds: ['iso']
  })
  await wait
  expect(settled).toBe(true)
})
