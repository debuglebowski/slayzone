/**
 * agentTurns tRPC router — onChanged subscription wiring.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --loader ./packages/shared/test-utils/loader.ts \
 *   packages/shared/transport/src/server/routers/agent-turns.test.ts
 *
 * `list` is exercised by agent-turns/src/main/handlers.test.ts (same extracted
 * fn). Here we cover the part nothing else touches: the streaming subscription
 * forwards every agentTurnsEvents emit, and teardown removes its listener.
 */
import { test, expect, describe } from '../../../../test-utils/ipc-harness.js'
import { agentTurnsRouter } from './agent-turns.js'
import { agentTurnsEvents } from '@slayzone/agent-turns/server'

// onChanged never touches ctx.db, so a stub context is enough.
const ctx = { db: {} as never, dataRoot: '' }

await describe('agentTurns.onChanged subscription', () => {
  test('forwards each agent-turns:changed emit, stops after unsubscribe', async () => {
    const caller = agentTurnsRouter.createCaller(ctx)
    const obs = await caller.onChanged()
    const got: string[] = []
    const sub = obs.subscribe({ next: (v: string) => got.push(v) })

    agentTurnsEvents.emit('agent-turns:changed', '/tmp/wt-a')
    agentTurnsEvents.emit('agent-turns:changed', '/tmp/wt-b')
    sub.unsubscribe()
    agentTurnsEvents.emit('agent-turns:changed', '/tmp/wt-after-unsub')

    expect(got).toEqual(['/tmp/wt-a', '/tmp/wt-b'])
  })

  test('teardown removes the listener (no leak)', async () => {
    const before = agentTurnsEvents.listenerCount('agent-turns:changed')
    const caller = agentTurnsRouter.createCaller(ctx)
    const obs = await caller.onChanged()
    const sub = obs.subscribe({ next: () => {} })
    expect(agentTurnsEvents.listenerCount('agent-turns:changed')).toBe(before + 1)
    sub.unsubscribe()
    expect(agentTurnsEvents.listenerCount('agent-turns:changed')).toBe(before)
  })
})
