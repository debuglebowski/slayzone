// @vitest-environment jsdom
// The branch graph loads per project path (spinner until the path's first
// fetch lands) and polls while visible. Task tabs live in <Activity>: re-showing
// the tab polls again at once, but keeps the graph on screen (no spinner).
// A project path change (the git panel's repo picker, a task gaining a worktree)
// reads the new path at once, and a read still in flight for the old path never
// lands: neither its graph nor the end of the new path's spinner.
import { Activity, useEffect, useLayoutEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Dag = { baseBranch: string; branches: string[]; commits: Array<{ hash: string }> }
let dagCalls: Array<{ path: string; d: Deferred<Dag> }> = []
const dag = (...hashes: string[]): Dag => ({
  baseBranch: 'main',
  branches: ['main'],
  commits: hashes.map((hash) => ({ hash, relativeDate: 'now' }))
})

vi.mock('@slayzone/transport/client', () => {
  const q = (fn: (input: { path: string }) => Promise<unknown>) => ({
    queryOptions: (input: { path: string }) => ({ queryFn: () => fn(input) })
  })
  // Stable: the hook keys effects and callbacks on `trpc`.
  const trpc = {
    worktrees: {
      fetch: { mutationOptions: () => ({}) },
      getCurrentBranch: q(async () => 'main'),
      resolveChildBranches: q(async () => ({ children: [], merged: [] })),
      getResolvedCommitDag: q((input) => {
        const d = deferred<Dag>()
        dagCalls.push({ path: input.path, d })
        return d.promise
      }),
      onDiffChanged: { subscriptionOptions: () => ({}) },
      onDiffWatchFailed: { subscriptionOptions: () => ({}) }
    },
    settings: { get: q(async () => null) }
  }
  const client = {}
  return {
    useTRPC: () => trpc,
    useTRPCClient: () => client,
    useSubscription: () => undefined
  }
})
vi.mock('@tanstack/react-query', () => {
  const mutation = { mutateAsync: async () => undefined }
  const queryClient = { fetchQuery: (opts: { queryFn: () => unknown }) => opts.queryFn() }
  return {
    useMutation: () => mutation,
    useQueryClient: () => queryClient
  }
})

const { useBranchGraph } = await import('./useBranchGraph')
const { _setGitDiffStoreTransport, _resetStore, notifyDiffChanged } = await import(
  './git-diff-store'
)

let latest: ReturnType<typeof useBranchGraph>
/** `loading` as of every commit. */
let committed: boolean[]
let renders = 0

function Probe({ path, visible }: { path: string | null; visible: boolean }) {
  renders++
  latest = useBranchGraph(path, visible)
  const loading = latest.loading
  useLayoutEffect(() => {
    committed.push(loading)
  })
  return null
}
function Tab({
  mode,
  path = '/repo',
  visible = true
}: {
  mode: 'visible' | 'hidden'
  path?: string | null
  visible?: boolean
}) {
  return (
    <Activity mode={mode}>
      <Probe path={path} visible={visible} />
    </Activity>
  )
}

/** Let the poll's chained fetchQuery awaits reach the DAG read. */
const flush = () => act(async () => {})
const land = (i: number, d: Dag) =>
  act(async () => {
    dagCalls[i].d.resolve(d)
  })
const callsFor = (path: string) => dagCalls.filter((c) => c.path === path)
/** Resolve every DAG read made so far for `path` (an already-settled one ignores it). */
const landAll = (path: string, d: Dag) =>
  act(async () => {
    for (const c of callsFor(path)) c.d.resolve(d)
  })
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
const hashes = () => latest.dagGraph?.commits.map((c) => c.hash) ?? null

beforeEach(() => {
  dagCalls = []
  committed = []
  _setGitDiffStoreTransport({
    getWorkingDiff: () => new Promise(() => {}),
    watchStart: async () => {},
    watchStop: async () => {}
  })
})
afterEach(() => {
  cleanup()
  _resetStore()
  _setGitDiffStoreTransport(null)
  vi.useRealTimers()
})

describe('useBranchGraph', () => {
  it('shows loading until the first fetch for the path lands', async () => {
    render(<Tab mode="visible" />)
    await flush()
    expect(latest.loading).toBe(true)
    expect(dagCalls.map((c) => c.path)).toEqual(['/repo'])
    await land(0, dag('c1'))
    expect(latest.loading).toBe(false)
    expect(hashes()).toEqual(['c1'])
  })

  it('a failed first read ends the spinner (no graph)', async () => {
    render(<Tab mode="visible" />)
    await flush()
    expect(latest.loading).toBe(true)
    await act(async () => {
      dagCalls[0].d.reject(new Error('git failed'))
    })
    expect(latest.loading).toBe(false)
    expect(hashes()).toBeNull()
  })

  it('no project path: loading, no read; a path then loads', async () => {
    const view = render(<Tab mode="visible" path={null} />)
    await flush()
    expect(latest.loading).toBe(true)
    expect(dagCalls).toHaveLength(0)

    view.rerender(<Tab mode="visible" path="/repo" />)
    await flush()
    expect(dagCalls.map((c) => c.path)).toEqual(['/repo'])
    await land(0, dag('c1'))
    expect(latest.loading).toBe(false)
    expect(hashes()).toEqual(['c1'])
  })

  it('polls again when the tab is shown, and the new graph lands', async () => {
    const view = render(<Tab mode="visible" />)
    await flush()
    await land(0, dag('c1'))

    view.rerender(<Tab mode="hidden" />)
    view.rerender(<Tab mode="visible" />)
    await flush()
    expect(dagCalls).toHaveLength(2)
    await land(1, dag('c2', 'c1'))
    expect(hashes()).toEqual(['c2', 'c1'])
  })

  it('polls on its cadence while visible, backing off while the graph is unchanged', async () => {
    vi.useFakeTimers()
    render(<Tab mode="visible" />)
    await flush()
    await land(0, dag('c1'))
    // Delay after each read: 10s on a change (or the first read), doubling per
    // unchanged read, capped at 60s.
    const steps: Array<[number, Dag]> = [
      [10_000, dag('c1')],
      [20_000, dag('c1')],
      [40_000, dag('c1')],
      [60_000, dag('c2', 'c1')],
      [10_000, dag('c2', 'c1')]
    ]
    for (const [delay, next] of steps) {
      const before = dagCalls.length
      await advance(delay - 1)
      expect(dagCalls).toHaveLength(before)
      await advance(1)
      expect(dagCalls).toHaveLength(before + 1)
      await land(before, next)
    }
    expect(dagCalls.every((c) => c.path === '/repo')).toBe(true)
    expect(hashes()).toEqual(['c2', 'c1'])
    expect(committed.at(-1)).toBe(false)
  })

  it('a poll read with an unchanged graph renders nothing', async () => {
    vi.useFakeTimers()
    render(<Tab mode="visible" />)
    await flush()
    await land(0, dag('c1'))
    await advance(10_000)
    await land(1, dag('c2', 'c1')) // a real change, then unchanged reads
    const before = renders
    for (const [i, delay] of [10_000, 20_000, 40_000].entries()) {
      await advance(delay)
      await land(i + 2, dag('c2', 'c1'))
    }
    expect(dagCalls).toHaveLength(5)
    expect(renders).toBe(before)
  })

  it('stops polling while not visible or while the tab is hidden; resumes at once', async () => {
    vi.useFakeTimers()
    const view = render(<Tab mode="visible" />)
    await flush()
    await land(0, dag('c1'))

    view.rerender(<Tab mode="visible" visible={false} />)
    await advance(120_000)
    expect(dagCalls).toHaveLength(1)
    view.rerender(<Tab mode="visible" />)
    await flush()
    expect(dagCalls).toHaveLength(2)
    await land(1, dag('c1'))

    view.rerender(<Tab mode="hidden" />)
    await advance(120_000)
    expect(dagCalls).toHaveLength(2)
    view.rerender(<Tab mode="visible" />)
    await flush()
    expect(dagCalls).toHaveLength(3)
    await land(2, dag('c1'))
    expect(latest.loading).toBe(false)
  })

  it('a project path change shows loading until that path loads', async () => {
    vi.useFakeTimers()
    const view = render(<Tab mode="visible" />)
    await flush()
    await land(0, dag('c1'))
    expect(latest.loading).toBe(false)

    view.rerender(<Tab mode="visible" path="/other" />)
    expect(latest.loading).toBe(true)
    // Covers the poll's next tick too (when the new path is read is pinned below).
    await advance(10_000)
    expect(dagCalls.map((c) => c.path)).toEqual(['/repo', '/other'])
    expect(latest.loading).toBe(true)
    await land(1, dag('o1'))
    expect(latest.loading).toBe(false)
    expect(hashes()).toEqual(['o1'])
  })

  it('returning to a path shows loading until that path is read again', async () => {
    vi.useFakeTimers()
    const view = render(<Tab mode="visible" />)
    await flush()
    await land(0, dag('c1'))

    view.rerender(<Tab mode="visible" path="/other" />)
    view.rerender(<Tab mode="visible" path="/repo" />)
    expect(latest.loading).toBe(true)
    await advance(10_000)
    expect(callsFor('/repo').length).toBeGreaterThan(1)
    expect(latest.loading).toBe(true)
    await landAll('/repo', dag('c1'))
    expect(latest.loading).toBe(false)
    expect(hashes()).toEqual(['c1'])
    // A late read for the path left in between changes nothing.
    await landAll('/other', dag('o1'))
    expect(latest.loading).toBe(false)
    expect(hashes()).toEqual(['c1'])
  })

  it('keeps the graph on screen while it re-polls on show (no loading)', async () => {
    const view = render(<Tab mode="visible" />)
    await flush()
    await land(0, dag('c1'))
    committed = []

    view.rerender(<Tab mode="hidden" />)
    view.rerender(<Tab mode="visible" />)
    await flush()
    expect(dagCalls).toHaveLength(2)
    await land(1, dag('c1'))
    expect(committed.length).toBeGreaterThan(0)
    expect(committed.every((loading) => !loading)).toBe(true)
    expect(hashes()).toEqual(['c1'])
  })

  it('a git change in the repo re-reads the graph at once (no waiting for the poll)', async () => {
    render(<Tab mode="visible" />)
    await flush()
    await land(0, dag('c1'))
    expect(dagCalls).toHaveLength(1)

    // A plain file edit doesn't move a ref: no re-read.
    await act(async () => notifyDiffChanged('/repo', false))
    await flush()
    expect(dagCalls).toHaveLength(1)

    await act(async () => notifyDiffChanged('/repo', true))
    await flush()
    expect(dagCalls).toHaveLength(2)
    await land(1, dag('c2', 'c1'))
    expect(hashes()).toEqual(['c2', 'c1'])
  })

  it('after a path change, git changes in the new repo re-read it; the old repo is ignored', async () => {
    vi.useFakeTimers()
    const view = render(<Tab mode="visible" />)
    await flush()
    await land(0, dag('c1'))
    view.rerender(<Tab mode="visible" path="/other" />)
    await advance(10_000)
    await landAll('/other', dag('o1'))
    const before = dagCalls.length

    await act(async () => notifyDiffChanged('/repo', true))
    await flush()
    expect(dagCalls).toHaveLength(before)

    await act(async () => notifyDiffChanged('/other', true))
    await flush()
    expect(dagCalls.map((c) => c.path).slice(before)).toEqual(['/other'])
    await land(before, dag('o2', 'o1'))
    expect(hashes()).toEqual(['o2', 'o1'])
  })

  describe('project path change while a read for the old path is in flight', () => {
    it("the old path's late graph does not land, nor end the new path's spinner", async () => {
      vi.useFakeTimers()
      const view = render(<Tab mode="visible" />)
      await flush()
      expect(callsFor('/repo')).toHaveLength(1)

      view.rerender(<Tab mode="visible" path="/other" />)
      expect(latest.loading).toBe(true)
      const before = renders
      await land(0, dag('r1'))
      expect(latest.loading).toBe(true)
      expect(hashes()).toBeNull()
      expect(renders).toBe(before) // it changes nothing at all
      expect(committed.at(-1)).toBe(true)

      await advance(10_000)
      await landAll('/other', dag('o1'))
      expect(latest.loading).toBe(false)
      expect(hashes()).toEqual(['o1'])
    })

    it("the old path's late failure does not end the new path's spinner", async () => {
      vi.useFakeTimers()
      const view = render(<Tab mode="visible" />)
      await flush()

      view.rerender(<Tab mode="visible" path="/other" />)
      const before = renders
      await act(async () => {
        dagCalls[0].d.reject(new Error('git failed'))
      })
      expect(latest.loading).toBe(true)
      expect(renders).toBe(before) // it changes nothing at all

      await advance(10_000)
      await landAll('/other', dag('o1'))
      expect(latest.loading).toBe(false)
      expect(hashes()).toEqual(['o1'])
    })

    it("the old path's graph does not land even when it settles right after the switch commits", async () => {
      // Outside act(), React runs a default-priority update's passive effects in a later
      // task than its commit, so a read can settle in between. Here the old read settles
      // from a layout effect of the switch's commit: its continuation runs as a microtask
      // right after the commit, before the passive effects' task. The hook must know the
      // new path by then.
      let switchPath: (p: string) => void = () => {}
      const switched = { settled: false, passiveRan: false }
      function Host() {
        const [path, setPath] = useState('/repo')
        useLayoutEffect(() => {
          switchPath = setPath
        }, [])
        return (
          <>
            <Probe path={path} visible />
            <SettleOldReadOnSwitch path={path} />
          </>
        )
      }
      function SettleOldReadOnSwitch({ path }: { path: string }) {
        useLayoutEffect(() => {
          if (path !== '/other') return
          dagCalls[0].d.resolve(dag('r1'))
          switched.settled = true
        }, [path])
        useEffect(() => {
          if (path === '/other') switched.passiveRan = true
        }, [path])
        return null
      }
      render(<Host />)
      await flush()
      expect(callsFor('/repo')).toHaveLength(1)

      const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      const actEnv = g.IS_REACT_ACT_ENVIRONMENT
      g.IS_REACT_ACT_ENVIRONMENT = false
      try {
        switchPath('/other')
        // Real scheduler: wait for the commit and its passive effects (by then the
        // settled read's continuation has run — microtasks precede the passive task).
        await vi.waitFor(() => expect(switched).toEqual({ settled: true, passiveRan: true }), {
          timeout: 4_000
        })
      } finally {
        g.IS_REACT_ACT_ENVIRONMENT = actEnv
      }
      expect(latest.loading).toBe(true)
      expect(hashes()).toBeNull()
      expect(callsFor('/other')).toHaveLength(1)

      await landAll('/other', dag('o1'))
      expect(latest.loading).toBe(false)
      expect(hashes()).toEqual(['o1'])
    })

    it("the old path's late graph does not replace the new path's graph", async () => {
      vi.useFakeTimers()
      const view = render(<Tab mode="visible" />)
      await flush()
      await land(0, dag('c1'))
      await advance(10_000) // poll tick: a second /repo read, held in flight
      expect(callsFor('/repo')).toHaveLength(2)

      view.rerender(<Tab mode="visible" path="/other" />)
      // A manual refresh (e.g. after a sync) reads the new path now, whatever the poll does.
      await act(async () => {
        void latest.refresh()
      })
      await landAll('/other', dag('o1'))
      expect(latest.loading).toBe(false)
      expect(hashes()).toEqual(['o1'])

      await land(1, dag('r2', 'c1'))
      expect(hashes()).toEqual(['o1'])
      expect(latest.loading).toBe(false)
    })
  })

  describe('a project path change reads the new path at once', () => {
    it('even while the poll is backed off; the new path then polls from the base delay', async () => {
      vi.useFakeTimers()
      const view = render(<Tab mode="visible" />)
      await flush()
      await land(0, dag('c1'))
      // Unchanged graph: the poll backs off to its 60s cap.
      for (const [i, delay] of [10_000, 20_000, 40_000].entries()) {
        await advance(delay)
        await land(i + 1, dag('c1'))
      }
      expect(callsFor('/repo')).toHaveLength(4)
      await advance(1_000)

      view.rerender(<Tab mode="visible" path="/other" />)
      await flush()
      expect(callsFor('/other')).toHaveLength(1)
      expect(latest.loading).toBe(true)
      await landAll('/other', dag('o1'))
      expect(latest.loading).toBe(false)
      expect(hashes()).toEqual(['o1'])

      await advance(9_999)
      expect(callsFor('/other')).toHaveLength(1)
      await advance(1)
      expect(callsFor('/other')).toHaveLength(2)
      expect(callsFor('/repo')).toHaveLength(4)
    })

    it("even while the old path's read is still in flight; the old path is never read again", async () => {
      vi.useFakeTimers()
      const view = render(<Tab mode="visible" />)
      await flush()
      await land(0, dag('c1'))
      await advance(10_000) // poll tick: a second /repo read, held in flight

      view.rerender(<Tab mode="visible" path="/other" />)
      await flush()
      expect(callsFor('/other')).toHaveLength(1)
      await landAll('/other', dag('o1'))
      expect(hashes()).toEqual(['o1'])

      // The abandoned /repo read settles late: it doesn't land, and starts no /repo polling.
      await land(1, dag('c1'))
      expect(hashes()).toEqual(['o1'])
      await advance(10_000)
      expect(callsFor('/other')).toHaveLength(2)
      await landAll('/other', dag('o1'))
      await advance(120_000)
      expect(callsFor('/repo')).toHaveLength(2)
    })
  })
})
