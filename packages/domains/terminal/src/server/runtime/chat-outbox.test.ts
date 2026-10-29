/**
 * The outbox: every user message has a delivery state, and nothing is shown as
 * delivered until the agent confirmed it. A message never vanishes — it ends
 * answered, cancelled, or failed with a reason (and can be retried).
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { OutgoingUserMessage } from '@slayzone/terminal-contracts'
import { chatWriteError } from './chat-proc-handle'
import { ChatOutbox, type OutboxProcess, type OutboxStateChange } from './chat-outbox'

const msg = (id: string, text = id): OutgoingUserMessage => ({
  id,
  content: [{ type: 'text', text }]
})

interface FakeProc extends Omit<OutboxProcess, 'ready'> {
  ready: boolean
  sent: string[]
  fail: ((id: string) => Error | null) | null
  pending: Map<string, () => void> | null
}

function proc(gen: number, opts: { native?: boolean; ready?: boolean } = {}): FakeProc {
  const p: FakeProc = {
    gen,
    ready: opts.ready ?? true,
    confirmsDelivery: opts.native ?? true,
    sent: [],
    fail: null,
    pending: null,
    send(message) {
      p.sent.push(message.id)
      const err = p.fail?.(message.id) ?? null
      if (err) return Promise.reject(err)
      if (p.pending) return new Promise<void>((resolve) => p.pending!.set(message.id, resolve))
      return Promise.resolve()
    }
  }
  return p
}

function harness(initial: FakeProc | null) {
  let current = initial
  const changes: OutboxStateChange[] = []
  const writing: string[] = []
  let readyWaiters: Array<{ resolve: (p: OutboxProcess) => void; reject: (e: unknown) => void }> =
    []
  const outbox = new ChatOutbox({
    current: () => current,
    ensureReady: () => {
      if (current?.ready) return Promise.resolve(current)
      return new Promise((resolve, reject) => readyWaiters.push({ resolve, reject }))
    },
    onChange: (c) => changes.push(c),
    onWriting: (id) => writing.push(id),
    retryWindowMs: 30_000
  })
  return {
    outbox,
    changes,
    writing,
    states: (id: string) => changes.filter((c) => c.id === id).map((c) => c.state),
    setCurrent(p: FakeProc | null) {
      current = p
    },
    becomeReady(p: FakeProc) {
      current = p
      p.ready = true
      const waiters = readyWaiters
      readyWaiters = []
      for (const w of waiters) w.resolve(p)
    },
    failStart(err: Error) {
      const waiters = readyWaiters
      readyWaiters = []
      for (const w of waiters) w.reject(err)
    }
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

test('ready process: written at once (same tick), sending → delivered → answered by the CLI', async () => {
  const p = proc(1)
  const h = harness(p)
  h.outbox.accept(msg('m1'))
  expect(p.sent).toEqual(['m1'])
  expect(h.writing).toEqual(['m1'])
  await flush()
  expect(h.states('m1')).toEqual(['sending'])
  h.outbox.onLifecycle(1, 'm1', 'queued')
  h.outbox.onLifecycle(1, 'm1', 'started')
  h.outbox.onLifecycle(1, 'm1', 'completed')
  expect(h.states('m1')).toEqual(['sending', 'delivered', 'answered'])
  expect(h.outbox.inFlight()).toBe(0)
})

test('the replay echo is a delivery confirmation too', async () => {
  const p = proc(1)
  const h = harness(p)
  h.outbox.accept(msg('m1'))
  await flush()
  h.outbox.onReplay(1, 'm1')
  expect(h.states('m1')).toEqual(['sending', 'delivered'])
})

test('a driver without native acks: delivered on write, answered on the next result', async () => {
  const p = proc(1, { native: false })
  const h = harness(p)
  h.outbox.accept(msg('m1'))
  await flush()
  expect(h.states('m1')).toEqual(['sending', 'delivered'])
  h.outbox.onResult(1)
  expect(h.states('m1')).toEqual(['sending', 'delivered', 'answered'])
})

test('a CLI that never sends lifecycle events: turn progress after the write confirms', async () => {
  const p = proc(1)
  const h = harness(p)
  h.outbox.accept(msg('m1'))
  await flush()
  h.outbox.onProgress(1)
  expect(h.states('m1')).toEqual(['sending', 'delivered'])
  h.outbox.onResult(1)
  expect(h.states('m1')).toEqual(['sending', 'delivered', 'answered'])
})

test('once the CLI sent lifecycle events, progress alone never confirms a message', async () => {
  const p = proc(1)
  const h = harness(p)
  h.outbox.accept(msg('m1'))
  await flush()
  h.outbox.onLifecycle(1, 'm1', 'queued')
  h.outbox.accept(msg('m2'))
  await flush()
  h.outbox.onProgress(1)
  expect(h.states('m2')).toEqual(['sending'])
})

test('no process yet: queued until it is ready, then written (the lazily-spawned first message)', async () => {
  const p = proc(1, { ready: false })
  const h = harness(null)
  h.outbox.accept(msg('m1'))
  expect(p.sent).toEqual([])
  expect(h.outbox.state('m1')).toBe('queued')
  h.becomeReady(p)
  await flush()
  expect(p.sent).toEqual(['m1'])
  expect(h.states('m1')).toEqual(['sending'])
})

test('a start failure fails the waiting messages with its reason', async () => {
  const h = harness(null)
  h.outbox.accept(msg('m1'))
  h.failStart(new Error('claude is not installed'))
  await flush()
  expect(h.changes).toEqual([{ id: 'm1', state: 'failed', error: 'claude is not installed' }])
})

test('messages are written in order, one at a time', async () => {
  const p = proc(1)
  p.pending = new Map()
  const h = harness(p)
  h.outbox.accept(msg('a'))
  h.outbox.accept(msg('b'))
  expect(p.sent).toEqual(['a'])
  p.pending.get('a')!()
  await flush()
  expect(p.sent).toEqual(['a', 'b'])
})

test('accepting the same id twice never sends it twice', async () => {
  const p = proc(1)
  const h = harness(p)
  h.outbox.accept(msg('m1'))
  h.outbox.accept(msg('m1'))
  await flush()
  expect(p.sent).toEqual(['m1'])
})

test('link down: retried with the same id until it goes through', async () => {
  const p = proc(1)
  let downFor = 2
  p.fail = () => (downFor-- > 0 ? chatWriteError('link-down', 'unreachable') : null)
  const h = harness(p)
  h.outbox.accept(msg('m1'))
  await flush()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(p.sent).toEqual(['m1', 'm1', 'm1'])
  expect(h.states('m1').at(-1)).toBe('sending')
  h.outbox.onLifecycle(1, 'm1', 'queued')
  expect(h.states('m1').at(-1)).toBe('delivered')
})

test('link down past the retry window: failed, with Retry left to the user', async () => {
  const p = proc(1)
  p.fail = () => chatWriteError('link-down', 'computer unreachable')
  const h = harness(p)
  h.outbox.accept(msg('m1'))
  await flush()
  await vi.advanceTimersByTimeAsync(31_000)
  expect(h.states('m1').at(-1)).toBe('failed')
  expect(h.changes.at(-1)?.error).toContain('unreachable')
  const sends = p.sent.length
  p.fail = null
  expect(h.outbox.retry('m1')).toBe(true)
  await flush()
  expect(p.sent.length).toBe(sends + 1)
  expect(h.states('m1').at(-1)).toBe('sending')
})

test('not delivered (stdin closed): failed at once', async () => {
  const p = proc(1)
  p.fail = () => chatWriteError('not-delivered', 'stdin is closed')
  const h = harness(p)
  h.outbox.accept(msg('m1'))
  await flush()
  expect(h.states('m1')).toEqual(['sending', 'failed'])
})

test('the process ends before confirming: failed (no silent loss)', async () => {
  const p = proc(1)
  const h = harness(p)
  h.outbox.accept(msg('m1'))
  await flush()
  h.outbox.onProcessEnded(1, { resend: false })
  expect(h.states('m1')).toEqual(['sending', 'failed'])
})

test('delivered then the process crashes: no auto-resend, no failure', async () => {
  const p = proc(1)
  const h = harness(p)
  h.outbox.accept(msg('m1'))
  await flush()
  h.outbox.onLifecycle(1, 'm1', 'started')
  h.outbox.onProcessEnded(1, { resend: false })
  expect(h.states('m1')).toEqual(['sending', 'delivered'])
  expect(h.outbox.inFlight()).toBe(0)
})

test('resend (failed resume / replaced process): re-sent with the same id to the next process', async () => {
  const p1 = proc(1)
  const h = harness(p1)
  h.outbox.accept(msg('m1'))
  await flush()
  h.setCurrent(null)
  h.outbox.onProcessEnded(1, { resend: true })
  expect(h.outbox.state('m1')).toBe('queued')
  const p2 = proc(2, { ready: false })
  h.becomeReady(p2)
  h.outbox.pump()
  await flush()
  expect(p2.sent).toEqual(['m1'])
  h.outbox.onLifecycle(2, 'm1', 'queued')
  expect(h.outbox.state('m1')).toBe('delivered')
})

test('events from an older process never move a message', async () => {
  const p1 = proc(1)
  const h = harness(p1)
  h.outbox.accept(msg('m1'))
  await flush()
  h.setCurrent(null)
  h.outbox.onProcessEnded(1, { resend: true })
  h.outbox.onLifecycle(1, 'm1', 'completed')
  expect(h.outbox.state('m1')).toBe('queued')
})

test('cancel (Stop on an unanswered turn) closes the entry', async () => {
  const p = proc(1)
  const h = harness(p)
  h.outbox.accept(msg('m1'))
  await flush()
  h.outbox.cancel('m1')
  expect(h.states('m1').at(-1)).toBe('cancelled')
  h.outbox.onProcessEnded(1, { resend: true })
  expect(h.outbox.state('m1')).toBe('cancelled')
})

test('restore after a restart: a message the old run never confirmed is failed, not lost', () => {
  const h = harness(null)
  h.outbox.restore([
    { kind: 'user-message', id: 'old-1', text: 'done', content: [{ type: 'text', text: 'done' }] },
    { kind: 'user-message-delivery', id: 'old-1', state: 'answered' },
    {
      kind: 'user-message',
      id: 'old-2',
      text: 'lost?',
      content: [{ type: 'text', text: 'lost?' }]
    },
    { kind: 'user-message', text: 'legacy row without id' }
  ])
  expect(h.changes).toEqual([
    {
      id: 'old-2',
      state: 'failed',
      error: 'Not sent: the app restarted before Claude Code confirmed it.'
    }
  ])
  expect(h.outbox.retry('old-2')).toBe(true)
})

test('inFlight counts every message the agent has not finished with', async () => {
  const p = proc(1)
  const h = harness(p)
  h.outbox.accept(msg('a'))
  h.outbox.accept(msg('b'))
  expect(h.outbox.inFlight()).toBe(2)
  await flush()
  h.outbox.onLifecycle(1, 'a', 'completed')
  await flush()
  h.outbox.onLifecycle(1, 'b', 'completed')
  expect(h.outbox.inFlight()).toBe(0)
})

test('a failed resume re-sends even a message its process had confirmed (the new conversation never saw it)', async () => {
  const p1 = proc(1)
  const h = harness(p1)
  h.outbox.accept(msg('m1'))
  await flush()
  h.outbox.onLifecycle(1, 'm1', 'started')
  h.setCurrent(null)
  h.outbox.onProcessEnded(1, { resend: true, resendDelivered: true })
  expect(h.outbox.state('m1')).toBe('queued')
  const p2 = proc(2, { ready: false })
  h.becomeReady(p2)
  h.outbox.pump()
  await flush()
  expect(p2.sent).toEqual(['m1'])
})
