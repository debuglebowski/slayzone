/**
 * chat tRPC router — proc delegation + streaming subscription wiring.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --loader ./packages/shared/test-utils/loader.ts \
 *   packages/shared/transport/src/server/routers/chat.test.ts
 *
 * The chat ops logic is covered by the terminal domain's own tests; here we
 * cover what's unique to the router: procedures delegate to the injected ops
 * (setChatDeps), and the 4 subscriptions forward every emit + tear their
 * listener down on unsubscribe.
 */
import { test, expect, describe } from '../../../../test-utils/ipc-harness.js'
import { TypedEmitter } from '@slayzone/platform/events'
import { chatRouter } from './chat.js'
import { setChatDeps, type ChatDeps } from '../app-deps.js'

const events = new TypedEmitter<{
  event: [tabId: string, agentEvent: unknown, seq: number]
  exit: [tabId: string, sessionId: string, code: number | null, signal: string | null]
}>()
const queueEvents = new TypedEmitter<{
  'queue-changed': [tabId: string]
  'queue-drained': [tabId: string, original: string]
}>()

const calls: string[] = []
const ops = {
  supports: (mode: string) => mode === 'claude-chat',
  getAutocompleteUsage: () => Promise.resolve({ foo: 1 })
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

await describe('chat router', () => {
  test('procedures + nested queue delegate to injected ops', async () => {
    const caller = chatRouter.createCaller(ctx)
    expect(await caller.supports({ mode: 'claude-chat' })).toEqual(true)
    expect(await caller.supports({ mode: 'pty' })).toEqual(false)
    expect(await caller.getAutocompleteUsage()).toEqual({ foo: 1 })
    await caller.queue.list({ tabId: 't1' })
    expect(calls).toEqual(['list:t1'])
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
