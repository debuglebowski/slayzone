// @vitest-environment jsdom
// The branch graph loads per project path (spinner until the path's first
// fetch lands) and polls while visible. Task tabs live in <Activity>: re-showing
// the tab polls again at once, but keeps the graph on screen (no spinner).
import { Activity, useLayoutEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
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
  return {
    useTRPC: () => ({
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
    }),
    useTRPCClient: () => ({}),
    useSubscription: () => undefined
  }
})
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutateAsync: vi.fn() }),
  useQueryClient: () => ({ fetchQuery: (opts: { queryFn: () => unknown }) => opts.queryFn() })
}))

const { useBranchGraph } = await import('./useBranchGraph')
const { _setGitDiffStoreTransport, _resetStore, notifyDiffChanged } = await import(
  './git-diff-store'
)

let latest: ReturnType<typeof useBranchGraph>
/** `loading` as of every commit. */
let committed: boolean[]

function Probe({ path }: { path: string }) {
  latest = useBranchGraph(path, true)
  const loading = latest.loading
  useLayoutEffect(() => {
    committed.push(loading)
  })
  return null
}
function Tab({ mode, path = '/repo' }: { mode: 'visible' | 'hidden'; path?: string }) {
  return (
    <Activity mode={mode}>
      <Probe path={path} />
    </Activity>
  )
}

/** Let the poll's chained fetchQuery awaits reach the DAG read. */
const flush = () => act(async () => {})
const land = (i: number, d: Dag) =>
  act(async () => {
    dagCalls[i].d.resolve(d)
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

  it('a project path change shows loading until that path loads', async () => {
    vi.useFakeTimers()
    try {
      const view = render(<Tab mode="visible" />)
      await flush()
      await land(0, dag('c1'))
      expect(latest.loading).toBe(false)

      view.rerender(<Tab mode="visible" path="/other" />)
      expect(latest.loading).toBe(true)
      // The new path is read on the poll's next tick (the poll is not restarted).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(dagCalls.map((c) => c.path)).toEqual(['/repo', '/other'])
      expect(latest.loading).toBe(true)
      await land(1, dag('o1'))
      expect(latest.loading).toBe(false)
      expect(hashes()).toEqual(['o1'])
    } finally {
      vi.useRealTimers()
    }
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
})
