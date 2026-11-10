/**
 * The git panel's watcher runs on the computer that holds the checkout. The hub
 * refcounts subscriptions per path (one computer watch for many panels), turns the
 * computer's reports into the same `git:diff-changed` its subscriptions already
 * stream, and on a lost computer reports `git:diff-watch-failed` (the panel polls)
 * and forgets the watch, so the next subscribe starts a fresh one.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { worktreesRouter } from './worktrees-router'
import { setWorktreesRouterDeps } from './worktrees-router-deps'
import { getGitWatcher } from './git-watcher'
import {
  deliverGitWatchEvent,
  gitWatchComputerGone,
  setGitOpTransport,
  type GitOpTransport
} from './git-op-routing'

const calls: string[] = []
const watchIds: string[] = []
const transport: GitOpTransport = {
  request: async () => null,
  watchStart: async (computerId, { watchId, worktreePath }) => {
    calls.push(`start ${computerId} ${worktreePath}`)
    watchIds.push(watchId)
  },
  watchStop: async (computerId, { watchId }) => {
    calls.push(`stop ${computerId} ${watchId === watchIds.at(-1) ? 'last' : watchId}`)
  }
}

beforeAll(() => {
  setWorktreesRouterDeps({
    getWorkspace: () => ({ fs: {} as never, resolveComputer: async () => 'c1' }),
    shellOpenPath: async () => ''
  })
  setGitOpTransport(transport)
})
afterAll(() => setGitOpTransport(null))

const noCheckouts = { get: async () => undefined, all: async () => [] }
const caller = worktreesRouter.createCaller({ db: noCheckouts as never, dataRoot: '' } as never)

describe('routed git watch', () => {
  test('two panels on one checkout share one computer watch; the last stop ends it', async () => {
    await caller.watchStart({ target: { projectId: 'p-test' }, worktreePath: '/w/r' })
    await caller.watchStart({ target: { projectId: 'p-test' }, worktreePath: '/w/r' })
    expect(calls).toEqual(['start c1 /w/r'])
    await caller.watchStop({ target: { projectId: 'p-test' }, worktreePath: '/w/r' })
    expect(calls).toEqual(['start c1 /w/r'])
    await caller.watchStop({ target: { projectId: 'p-test' }, worktreePath: '/w/r' })
    expect(calls).toEqual(['start c1 /w/r', 'stop c1 last'])
  })

  test("the computer's report becomes the panel's diff-changed", async () => {
    calls.length = 0
    await caller.watchStart({ target: { projectId: 'p-test' }, worktreePath: '/w/s' })
    const seen: unknown[] = []
    const on = (p: unknown) => seen.push(p)
    getGitWatcher().on('git:diff-changed', on)
    deliverGitWatchEvent('c1', { watchId: watchIds.at(-1)!, kind: 'changed', refsChanged: true })
    deliverGitWatchEvent('c2', { watchId: watchIds.at(-1)!, kind: 'changed', refsChanged: true })
    getGitWatcher().off('git:diff-changed', on)
    expect(seen).toEqual([{ worktreePath: '/w/s', refsChanged: true, projectId: 'p-test' }])
    await caller.watchStop({ target: { projectId: 'p-test' }, worktreePath: '/w/s' })
  })

  test('a lost computer: watch-failed, and the next subscribe starts afresh', async () => {
    calls.length = 0
    await caller.watchStart({ target: { projectId: 'p-test' }, worktreePath: '/w/t' })
    const failed: unknown[] = []
    const on = (p: unknown) => failed.push(p)
    getGitWatcher().on('git:diff-watch-failed', on)
    gitWatchComputerGone('c1')
    getGitWatcher().off('git:diff-watch-failed', on)
    expect(failed).toEqual([{ worktreePath: '/w/t', projectId: 'p-test' }])
    await caller.watchStart({ target: { projectId: 'p-test' }, worktreePath: '/w/t' })
    expect(calls).toEqual(['start c1 /w/t', 'start c1 /w/t'])
  })

  // Final review M3: a second panel joining a start still in flight counted itself in
  // and resolved at once; when the start then failed only the first panel heard, and
  // the second thought it was live (30 s poll). A joiner waits for the start, and a
  // failed start is reported to the path's subscribers.
  test('a panel joining a start that fails is told too', async () => {
    let fail: (err: Error) => void = () => undefined
    setGitOpTransport({
      ...transport,
      watchStart: () =>
        new Promise<void>((_, reject) => {
          fail = reject
        })
    })
    const failed: unknown[] = []
    const on = (p: unknown) => failed.push(p)
    getGitWatcher().on('git:diff-watch-failed', on)
    try {
      const first = caller.watchStart({ target: { projectId: 'p-test' }, worktreePath: '/w/u' })
      await new Promise((r) => setTimeout(r, 10))
      const second = caller.watchStart({ target: { projectId: 'p-test' }, worktreePath: '/w/u' })
      await new Promise((r) => setTimeout(r, 10))
      fail(new Error('computer gone'))
      const outcomes = await Promise.allSettled([first, second])
      expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected'])
      expect(failed).toEqual([{ worktreePath: '/w/u', projectId: 'p-test' }])
    } finally {
      getGitWatcher().off('git:diff-watch-failed', on)
      setGitOpTransport(transport)
    }
    // Nothing left counted: the next start is a fresh one.
    calls.length = 0
    await caller.watchStart({ target: { projectId: 'p-test' }, worktreePath: '/w/u' })
    expect(calls).toEqual(['start c1 /w/u'])
    await caller.watchStop({ target: { projectId: 'p-test' }, worktreePath: '/w/u' })
  })
})
