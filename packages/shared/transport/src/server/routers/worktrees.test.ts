/**
 * worktrees tRPC router — git fs-watcher subscription wiring.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --loader ./packages/shared/test-utils/loader.ts \
 *   packages/shared/transport/src/server/routers/worktrees.test.ts
 *
 * The 84 req/res procs are thin wrappers over already-tested git ops. Here we
 * cover the part nothing else touches: the two streaming subscriptions forward
 * every getGitWatcher() emit and teardown removes their listener (no leak —
 * the watcher is a singleton EventEmitter shared across all subscribers).
 */
import { test, expect, describe } from '../../../../test-utils/ipc-harness.js'
import { worktreesRouter } from './worktrees.js'
import { getGitWatcher } from '@slayzone/worktrees/server'

// The watcher subscriptions never touch ctx.db, so a stub context is enough.
const ctx = { db: {} as never, dataRoot: '' }

await describe('worktrees watcher subscriptions', () => {
  test('onDiffChanged forwards each emit, stops after unsubscribe', async () => {
    const watcher = getGitWatcher()
    const caller = worktreesRouter.createCaller(ctx)
    const obs = await caller.onDiffChanged()
    const got: string[] = []
    const sub = obs.subscribe({ next: (v: { worktreePath: string }) => got.push(v.worktreePath) })

    watcher.emit('git:diff-changed', { worktreePath: '/tmp/wt-a' })
    watcher.emit('git:diff-changed', { worktreePath: '/tmp/wt-b' })
    sub.unsubscribe()
    watcher.emit('git:diff-changed', { worktreePath: '/tmp/wt-after-unsub' })

    expect(got).toEqual(['/tmp/wt-a', '/tmp/wt-b'])
  })

  test('onDiffWatchFailed forwards each emit', async () => {
    const watcher = getGitWatcher()
    const caller = worktreesRouter.createCaller(ctx)
    const obs = await caller.onDiffWatchFailed()
    const got: string[] = []
    const sub = obs.subscribe({ next: (v: { worktreePath: string }) => got.push(v.worktreePath) })

    watcher.emit('git:diff-watch-failed', { worktreePath: '/tmp/wt-x' })
    sub.unsubscribe()

    expect(got).toEqual(['/tmp/wt-x'])
  })

  test('teardown removes the listener (no leak)', async () => {
    const watcher = getGitWatcher()
    const before = watcher.listenerCount('git:diff-changed')
    const caller = worktreesRouter.createCaller(ctx)
    const obs = await caller.onDiffChanged()
    const sub = obs.subscribe({ next: () => {} })
    expect(watcher.listenerCount('git:diff-changed')).toBe(before + 1)
    sub.unsubscribe()
    expect(watcher.listenerCount('git:diff-changed')).toBe(before)
  })
})
