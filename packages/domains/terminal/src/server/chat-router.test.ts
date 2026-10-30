/**
 * chat tRPC router — proc delegation + streaming subscription wiring.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/domains/terminal/src/server/chat-router.test.ts
 *
 * The chat ops logic is covered by the terminal domain's own tests; here we
 * cover what's unique to the router: procedures delegate to the injected ops
 * (setChatDeps), and the 4 subscriptions forward every emit + tear their
 * listener down on unsubscribe.
 */
import { describe, test, expect } from 'vitest'
import { TypedEmitter } from '@slayzone/platform/events'
import { chatRouter } from './chat-router.js'
import { setChatDeps, type ChatDeps } from './chat-router-deps.js'

const events = new TypedEmitter<{
  event: [tabId: string, agentEvent: unknown, seq: number]
  exit: [tabId: string, sessionId: string, code: number | null, signal: string | null]
}>()
const queueEvents = new TypedEmitter<{
  'queue-changed': [tabId: string]
  'queue-drained': [tabId: string, original: string]
}>()

const calls: string[] = []
const watchdogCalls: unknown[] = []
const ops = {
  supports: (mode: string) => mode === 'claude-chat',
  getAutocompleteUsage: () => Promise.resolve({ foo: 1 }),
  testSetWatchdogTimings: (timings: unknown) => {
    watchdogCalls.push(timings)
  }
} as unknown as ChatDeps['ops']
const queueOps = {
  list: (tabId: string) => {
    calls.push(`list:${tabId}`)
    return Promise.resolve([])
  }
} as unknown as ChatDeps['queueOps']

setChatDeps({ ops, queueOps, events, queueEvents } as unknown as ChatDeps)

// The router reads ops via the getChatDeps() singleton, not ctx — stub is enough.
const ctx = { db: {} as never, dataRoot: '' }

describe('chat router', () => {
  test('procedures + nested queue delegate to injected ops', async () => {
    const caller = chatRouter.createCaller(ctx)
    expect(await caller.supports({ mode: 'claude-chat' })).toEqual(true)
    expect(await caller.supports({ mode: 'pty' })).toEqual(false)
    expect(await caller.getAutocompleteUsage()).toEqual({ foo: 1 })
    await caller.queue.list({ tabId: 't1' })
    expect(calls).toEqual(['list:t1'])
  })

  // The e2e chat group shortens the watchdog per spec (audit #4) — never in a
  // normal boot, same gate as pty-router's test procedures.
  test('testSetWatchdogTimings is PLAYWRIGHT-gated and delegates to ops', async () => {
    const caller = chatRouter.createCaller(ctx)
    const timings = { startingBoundMs: 1000, runningStallMs: 1500, killGraceMs: 200 }
    const saved = process.env.PLAYWRIGHT
    try {
      delete process.env.PLAYWRIGHT
      await expect(caller.testSetWatchdogTimings({ timings })).rejects.toThrow(
        'test-only handler unavailable'
      )
      expect(watchdogCalls).toEqual([])
      process.env.PLAYWRIGHT = '1'
      await caller.testSetWatchdogTimings({ timings })
      await caller.testSetWatchdogTimings({ timings: null })
      expect(watchdogCalls).toEqual([timings, null])
    } finally {
      if (saved === undefined) delete process.env.PLAYWRIGHT
      else process.env.PLAYWRIGHT = saved
    }
  })

  test('onEvent forwards each emit, stops after unsubscribe', async () => {
    const caller = chatRouter.createCaller(ctx)
    const obs = await caller.onEvent()
    const got: Array<{ tabId: string; seq: number }> = []
    const sub = obs.subscribe({ next: (v) => got.push({ tabId: v.tabId, seq: v.seq }) })

    events.emit('event', 'tab-a', { kind: 'assistant-text' }, 1)
    events.emit('event', 'tab-b', { kind: 'result' }, 2)
    sub.unsubscribe()
    events.emit('event', 'tab-after', {}, 3)

    expect(got).toEqual([
      { tabId: 'tab-a', seq: 1 },
      { tabId: 'tab-b', seq: 2 }
    ])
  })

  test('onEvent with NO tabIds is the unfiltered firehose (unchanged, every existing caller)', async () => {
    const caller = chatRouter.createCaller(ctx)
    const obs = await caller.onEvent(undefined)
    const got: string[] = []
    const sub = obs.subscribe({ next: (v) => got.push(v.tabId) })
    events.emit('event', 'tab-a', {}, 1)
    events.emit('event', 'tab-b', {}, 2)
    sub.unsubscribe()
    expect(got).toEqual(['tab-a', 'tab-b'])
  })

  test('onEvent with tabIds filters server-side — the web-bandwidth fix', async () => {
    const caller = chatRouter.createCaller(ctx)
    const obs = await caller.onEvent({ tabIds: ['tab-a'] })
    const got: string[] = []
    const sub = obs.subscribe({ next: (v) => got.push(v.tabId) })

    // tab-b's event must never reach this subscriber at all — not filtered
    // client-side, dropped before emit.next ever runs.
    events.emit('event', 'tab-b', {}, 1)
    events.emit('event', 'tab-a', {}, 2)
    events.emit('event', 'tab-c', {}, 3)
    sub.unsubscribe()

    expect(got).toEqual(['tab-a'])
  })

  test('onQueueChanged forwards emits + teardown removes listener (no leak)', async () => {
    const before = queueEvents.listenerCount('queue-changed')
    const caller = chatRouter.createCaller(ctx)
    const obs = await caller.onQueueChanged()
    const got: string[] = []
    const sub = obs.subscribe({ next: (v) => got.push(v.tabId) })
    expect(queueEvents.listenerCount('queue-changed')).toEqual(before + 1)

    queueEvents.emit('queue-changed', 'tab-x')
    sub.unsubscribe()
    queueEvents.emit('queue-changed', 'tab-after')

    expect(got).toEqual(['tab-x'])
    expect(queueEvents.listenerCount('queue-changed')).toEqual(before)
  })
})

describe('chat router — command tasks (plan 3.9)', () => {
  test('commandTaskOutput / stopCommandTask / backgroundCommandTask delegate to ops', async () => {
    const seen: unknown[] = []
    Object.assign(ops, {
      commandTaskOutput: (tabId: string, taskId: string) => {
        seen.push(['output', tabId, taskId])
        return Promise.resolve({ state: 'running', output: 'x', totalBytes: 1, truncated: false })
      },
      stopCommandTask: (tabId: string, taskId: string) => {
        seen.push(['stop', tabId, taskId])
        return Promise.resolve()
      },
      backgroundCommandTask: (tabId: string, toolUseId: string) => {
        seen.push(['background', tabId, toolUseId])
        return Promise.resolve(true)
      }
    })
    const caller = chatRouter.createCaller(ctx)
    expect(await caller.commandTaskOutput({ tabId: 't1', taskId: 'k1' })).toEqual({
      state: 'running',
      output: 'x',
      totalBytes: 1,
      truncated: false
    })
    await caller.stopCommandTask({ tabId: 't1', taskId: 'k1' })
    expect(await caller.backgroundCommandTask({ tabId: 't1', toolUseId: 'toolu_1' })).toBe(true)
    expect(seen).toEqual([
      ['output', 't1', 'k1'],
      ['stop', 't1', 'k1'],
      ['background', 't1', 'toolu_1']
    ])
  })
})
