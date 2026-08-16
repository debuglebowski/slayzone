/**
 * pty tRPC router — `onData`'s server-side session filter.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --experimental-loader ./packages/shared/test-utils/loader.ts \
 *   packages/shared/transport/src/server/routers/pty.test.ts
 *
 * SCOPE: this file exists for ONE thing — `onData`'s optional `sessionIds`
 * input, added because the subscription was otherwise a firehose: every byte
 * of every live pty session on the hub, filtered only client-side
 * (PtyContext.tsx). Fine on a LAN desktop; not fine over cellular, and not
 * fine at all for a `read`-scoped web session (see scopes.ts). The other ~48
 * procedures on this router are covered by the terminal domain's own tests
 * (pty-manager.ts etc.) and by scopes.test.ts's exhaustiveness check — this
 * file does not attempt a full router audit.
 */
import { test, expect, describe } from '../../../../test-utils/ipc-harness.js'
import { TypedEmitter } from '@slayzone/platform/events'
import { ptyRouter } from './pty.js'
import { setPtyDeps, type PtyDeps } from '../app-deps.js'

const events = new TypedEmitter<PtyDeps['events'] extends TypedEmitter<infer M> ? M : never>()

setPtyDeps({ ops: {} as unknown as PtyDeps['ops'], events } as unknown as PtyDeps)

const ctx = { db: {} as never, dataRoot: '' }

await describe('pty router', () => {
  test('onData with NO sessionIds is the unfiltered firehose (unchanged, every existing caller)', async () => {
    const caller = ptyRouter.createCaller(ctx)
    const obs = await caller.onData(undefined)
    const got: string[] = []
    const sub = obs.subscribe({ next: (v) => got.push(v.sessionId) })
    events.emit('data', 'sess-a', 'hello', 1)
    events.emit('data', 'sess-b', 'world', 2)
    sub.unsubscribe()
    events.emit('data', 'sess-after-unsub', 'x', 3)
    expect(got).toEqual(['sess-a', 'sess-b'])
  })

  test('onData with sessionIds filters server-side — the web-bandwidth fix', async () => {
    const caller = ptyRouter.createCaller(ctx)
    const obs = await caller.onData({ sessionIds: ['sess-a'] })
    const got: Array<{ sessionId: string; data: string }> = []
    const sub = obs.subscribe({ next: (v) => got.push({ sessionId: v.sessionId, data: v.data }) })

    // sess-b's byte must never reach this subscriber — dropped before
    // emit.next runs, not filtered after the fact client-side.
    events.emit('data', 'sess-b', 'off-limits', 1)
    events.emit('data', 'sess-a', 'in-scope', 2)
    events.emit('data', 'sess-c', 'also-off-limits', 3)
    sub.unsubscribe()

    expect(got).toEqual([{ sessionId: 'sess-a', data: 'in-scope' }])
  })

  test('onData with an EMPTY sessionIds array admits nothing (not treated as "no filter")', async () => {
    // `[]` and `undefined` must not collapse to the same behavior — an empty
    // array is an explicit "subscribe to nothing yet", e.g. before a web
    // client has picked which task's terminal to watch.
    const caller = ptyRouter.createCaller(ctx)
    const obs = await caller.onData({ sessionIds: [] })
    const got: string[] = []
    const sub = obs.subscribe({ next: (v) => got.push(v.sessionId) })
    events.emit('data', 'sess-a', 'x', 1)
    sub.unsubscribe()
    expect(got).toEqual([])
  })
})
