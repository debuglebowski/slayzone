// @vitest-environment jsdom
// The task git panel's General tab runs two polls (real useStablePoll here, fake
// timers): the git poll (repo check, branches, status, ahead/behind — keyed on the
// project path and the task checkout) and the branch poll (fork point, ahead counts,
// diff stats — keyed on the task checkout, the project path and the parent branch).
// Each loads once (isGitRepo / branchLoading), polls while visible and backs off while
// nothing changes. A key change reads the new target at once, and a read still in
// flight for the old target never lands: neither its data nor the end of loading.
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Task } from '@slayzone/task-contracts'

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Stable: the hook keys callbacks on `trpc`. Query options carry their key; mutations
// answer from `mutationResults`.
const mutationResults: Record<string, unknown> = {}
const procCache = new Map<string, object>()
const procs = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      let p = procCache.get(name)
      if (!p) {
        p = {
          queryOptions: (input: unknown, opts?: object) => ({ ...opts, queryKey: [name, input] }),
          subscriptionOptions: () => ({}),
          mutationOptions: () => ({ mutationFn: async () => mutationResults[name] })
        }
        procCache.set(name, p)
      }
      return p
    }
  }
)
const trpc = { worktrees: procs, settings: procs }
const trpcClient = {
  worktrees: { watchStart: { mutate: async () => {} }, watchStop: { mutate: async () => {} } }
}
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => trpc,
  useTRPCClient: () => trpcClient,
  useSubscription: () => undefined
}))

const { useConsolidatedGeneralData } = await import('./useConsolidatedGeneralData')
const { _setGitDiffStoreTransport, _resetStore, notifyDiffChanged } = await import(
  './git-diff-store'
)

// The held reads: the git poll's status read (only it reads status) and the branch
// poll's fork-graph read. Everything else answers at once.
type Status = { staged: number; unstaged: number; untracked: number }
type Fork = { forkPoint: string; featureCount: number; baseCount: number }
let statusCalls: Array<{ repoPath: string; d: Deferred<Status> }> = []
let forkCalls: Array<{ targetPath: string; compareBranch: string; d: Deferred<Fork> }> = []

function answer(key: string, input: Record<string, unknown>): Promise<unknown> {
  switch (key) {
    case 'isGitRepo':
      return Promise.resolve(true)
    case 'getCurrentBranch':
      return Promise.resolve(input.path === '/repo' || input.path === '/repo2' ? 'main' : 'feat')
    case 'getStatusSummary': {
      const d = deferred<Status>()
      statusCalls.push({ repoPath: input.repoPath as string, d })
      return d.promise
    }
    case 'getResolvedForkGraph': {
      const d = deferred<Fork>()
      forkCalls.push({
        targetPath: input.targetPath as string,
        compareBranch: input.compareBranch as string,
        d
      })
      return d.promise
    }
    default:
      return Promise.resolve(null)
  }
}

const baseTask = {
  id: 'task-0001',
  title: 'My task',
  project_id: 'p1',
  worktree_path: '/wt1',
  worktree_parent_branch: 'main',
  base_dir: null,
  pr_url: null
} as unknown as Task
const taskWith = (over: Partial<Task>) => ({ ...baseTask, ...over }) as unknown as Task

type Props = { task: Task; projectPath: string | null; visible: boolean }
function setup(initial: Partial<Props> = {}) {
  const byKey = (o: { queryKey: readonly unknown[] }) =>
    answer(String(o.queryKey[0]), (o.queryKey[1] ?? {}) as Record<string, unknown>)
  const client = new QueryClient({
    defaultOptions: { queries: { queryFn: byKey as never, retry: false } }
  })
  vi.spyOn(client, 'fetchQuery').mockImplementation(byKey as never)
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const onUpdateTask = async () => baseTask
  return renderHook(
    (p: Props) => useConsolidatedGeneralData(p.task, p.projectPath, p.visible, 5000, onUpdateTask),
    {
      wrapper,
      initialProps: { task: baseTask, projectPath: '/repo', visible: true, ...initial }
    }
  )
}

const status = (n: number): Status => ({ staged: n, unstaged: 0, untracked: 0 })
const fork = (forkPoint: string): Fork => ({ forkPoint, featureCount: 1, baseCount: 0 })
const flush = () => act(async () => {})
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
const statusFor = (path: string) => statusCalls.filter((c) => c.repoPath === path)
const forkFor = (path: string, parent = 'main') =>
  forkCalls.filter((c) => c.targetPath === path && c.compareBranch === parent)
const landStatus = (i: number, s: Status) =>
  act(async () => {
    statusCalls[i].d.resolve(s)
  })
const landAllStatus = (path: string, s: Status) =>
  act(async () => {
    for (const c of statusFor(path)) c.d.resolve(s)
  })
const landFork = (i: number, f: Fork) =>
  act(async () => {
    forkCalls[i].d.resolve(f)
  })
const landAllFork = (path: string, f: Fork, parent = 'main') =>
  act(async () => {
    for (const c of forkFor(path, parent)) c.d.resolve(f)
  })

beforeEach(() => {
  statusCalls = []
  forkCalls = []
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

describe('useConsolidatedGeneralData — git poll', () => {
  it('isGitRepo is unknown until the first read lands', async () => {
    const { result } = setup()
    await flush()
    expect(result.current.isGitRepo).toBeNull()
    expect(statusCalls.map((c) => c.repoPath)).toEqual(['/wt1'])
    await landStatus(0, status(1))
    expect(result.current.isGitRepo).toBe(true)
    expect(result.current.statusSummary).toEqual(status(1))
    expect(result.current.currentBranch).toBe('main')
  })

  it('polls every 5s while visible, backing off while nothing changes', async () => {
    vi.useFakeTimers()
    const { result } = setup()
    await flush()
    await landStatus(0, status(1))
    const steps: Array<[number, Status]> = [
      [5_000, status(1)],
      [10_000, status(1)],
      [20_000, status(1)],
      [40_000, status(1)],
      [60_000, status(1)],
      [60_000, status(2)],
      [5_000, status(2)]
    ]
    for (const [delay, next] of steps) {
      const before = statusCalls.length
      await advance(delay - 1)
      expect(statusCalls).toHaveLength(before)
      await advance(1)
      expect(statusCalls).toHaveLength(before + 1)
      await landStatus(before, next)
    }
    expect(statusCalls.every((c) => c.repoPath === '/wt1')).toBe(true)
    expect(result.current.statusSummary).toEqual(status(2))
  })

  it('stops polling while not visible; resumes at once', async () => {
    vi.useFakeTimers()
    const { rerender } = setup()
    await flush()
    await landStatus(0, status(1))
    rerender({ task: baseTask, projectPath: '/repo', visible: false })
    await advance(120_000)
    expect(statusCalls).toHaveLength(1)
    rerender({ task: baseTask, projectPath: '/repo', visible: true })
    await flush()
    expect(statusCalls).toHaveLength(2)
  })

  it('a git change in the task checkout re-reads at once', async () => {
    vi.useFakeTimers()
    setup()
    await flush()
    await landStatus(0, status(1))
    await act(async () => notifyDiffChanged('/wt1'))
    await flush()
    expect(statusCalls).toHaveLength(2)
  })

  it('a checkout change keeps the repo known and the old data on screen until the new one lands', async () => {
    vi.useFakeTimers()
    const { result, rerender } = setup()
    await flush()
    await landStatus(0, status(1))
    rerender({ task: taskWith({ worktree_path: '/wt2' }), projectPath: '/repo', visible: true })
    expect(result.current.isGitRepo).toBe(true)
    expect(result.current.statusSummary).toEqual(status(1))
    // Covers the poll's next tick too (when the new checkout is read is pinned below).
    await advance(5_000)
    await landAllStatus('/wt2', status(2))
    expect(result.current.statusSummary).toEqual(status(2))
  })

  describe('a checkout change while a read for the old checkout is in flight', () => {
    it("the old checkout's late first read does not land, nor end loading", async () => {
      vi.useFakeTimers()
      const { result, rerender } = setup()
      await flush()
      rerender({ task: taskWith({ worktree_path: '/wt2' }), projectPath: '/repo', visible: true })
      await landStatus(0, status(1))
      expect(result.current.isGitRepo).toBeNull()
      expect(result.current.statusSummary).toBeNull()

      await advance(5_000)
      await landAllStatus('/wt2', status(2))
      expect(result.current.isGitRepo).toBe(true)
      expect(result.current.statusSummary).toEqual(status(2))
    })

    it("the old checkout's late read does not replace the new checkout's data", async () => {
      vi.useFakeTimers()
      const { result, rerender } = setup()
      await flush()
      await landStatus(0, status(1))
      await advance(5_000) // poll tick: a second /wt1 read, held in flight
      expect(statusFor('/wt1')).toHaveLength(2)

      rerender({ task: taskWith({ worktree_path: '/wt2' }), projectPath: '/repo', visible: true })
      // The external refresh (after a sync) reads the new checkout now.
      await act(async () => {
        void result.current.fetchGitData()
      })
      await landAllStatus('/wt2', status(2))
      expect(result.current.statusSummary).toEqual(status(2))

      await landStatus(1, status(7))
      expect(result.current.statusSummary).toEqual(status(2))
    })
  })

  describe('a key change reads the new target at once', () => {
    it('a checkout change, even while backed off; then polls from the base delay', async () => {
      vi.useFakeTimers()
      const { result, rerender } = setup()
      await flush()
      await landStatus(0, status(1))
      for (const [i, delay] of [5_000, 10_000, 20_000, 40_000].entries()) {
        await advance(delay)
        await landStatus(i + 1, status(1))
      }
      expect(statusFor('/wt1')).toHaveLength(5)
      await advance(1_000)

      rerender({ task: taskWith({ worktree_path: '/wt2' }), projectPath: '/repo', visible: true })
      await flush()
      expect(statusFor('/wt2')).toHaveLength(1)
      await landAllStatus('/wt2', status(2))
      expect(result.current.statusSummary).toEqual(status(2))

      await advance(4_999)
      expect(statusFor('/wt2')).toHaveLength(1)
      await advance(1)
      expect(statusFor('/wt2')).toHaveLength(2)
      expect(statusFor('/wt1')).toHaveLength(5)
    })

    it("a checkout change, even while the old read is in flight; the old checkout isn't polled again", async () => {
      vi.useFakeTimers()
      const { rerender } = setup()
      await flush()
      await landStatus(0, status(1))
      await advance(5_000) // poll tick: a second /wt1 read, held in flight

      rerender({ task: taskWith({ worktree_path: '/wt2' }), projectPath: '/repo', visible: true })
      await flush()
      expect(statusFor('/wt2')).toHaveLength(1)
      await landAllStatus('/wt2', status(2))
      await landStatus(1, status(1))
      await advance(5_000)
      expect(statusFor('/wt2')).toHaveLength(2)
      await landAllStatus('/wt2', status(2))
      await advance(120_000)
      expect(statusFor('/wt1')).toHaveLength(2)
    })

    it('a project path change (no own checkout)', async () => {
      vi.useFakeTimers()
      const noWt = taskWith({ worktree_path: null, worktree_parent_branch: null })
      const { result, rerender } = setup({ task: noWt })
      await flush()
      await landStatus(0, status(1))
      await advance(5_000)
      await landStatus(1, status(1)) // backed off to 10s
      await advance(1_000)

      rerender({ task: noWt, projectPath: '/repo2', visible: true })
      await flush()
      expect(statusFor('/repo2')).toHaveLength(1)
      await landAllStatus('/repo2', status(3))
      expect(result.current.statusSummary).toEqual(status(3))
    })
  })
})

describe('useConsolidatedGeneralData — branch poll', () => {
  it('branchLoading holds until the first comparison lands', async () => {
    const { result } = setup()
    await flush()
    expect(result.current.branchLoading).toBe(true)
    expect(forkCalls.map((c) => c.targetPath)).toEqual(['/wt1'])
    await landFork(0, fork('f1'))
    expect(result.current.branchLoading).toBe(false)
    expect(result.current.forkPoint).toBe('f1')
    expect(result.current.taskBranch).toBe('feat')
  })

  it('a failed first comparison ends branchLoading', async () => {
    const { result } = setup()
    await flush()
    await act(async () => {
      forkCalls[0].d.reject(new Error('git failed'))
    })
    expect(result.current.branchLoading).toBe(false)
    expect(result.current.forkPoint).toBeNull()
  })

  it('polls every 5s while visible, backing off while nothing changes; stops while hidden', async () => {
    vi.useFakeTimers()
    const { result, rerender } = setup()
    await flush()
    await landFork(0, fork('f1'))
    const steps: Array<[number, Fork]> = [
      [5_000, fork('f1')],
      [10_000, fork('f1')],
      [20_000, fork('f1')],
      [40_000, fork('f1')],
      [60_000, fork('f2')],
      [5_000, fork('f2')]
    ]
    for (const [delay, next] of steps) {
      const before = forkCalls.length
      await advance(delay - 1)
      expect(forkCalls).toHaveLength(before)
      await advance(1)
      expect(forkCalls).toHaveLength(before + 1)
      await landFork(before, next)
    }
    expect(result.current.forkPoint).toBe('f2')

    rerender({ task: baseTask, projectPath: '/repo', visible: false })
    const before = forkCalls.length
    await advance(120_000)
    expect(forkCalls).toHaveLength(before)
  })

  it('a checkout change after the first load keeps branchLoading off and the old data until the new lands', async () => {
    vi.useFakeTimers()
    const { result, rerender } = setup()
    await flush()
    await landFork(0, fork('f1'))
    rerender({ task: taskWith({ worktree_path: '/wt2' }), projectPath: '/repo', visible: true })
    expect(result.current.branchLoading).toBe(false)
    expect(result.current.forkPoint).toBe('f1')
    await advance(5_000)
    await landAllFork('/wt2', fork('f2'))
    expect(result.current.branchLoading).toBe(false)
    expect(result.current.forkPoint).toBe('f2')
  })

  it("a checkout change: the old checkout's late first comparison does not land, nor end branchLoading", async () => {
    vi.useFakeTimers()
    const { result, rerender } = setup()
    await flush()
    rerender({ task: taskWith({ worktree_path: '/wt2' }), projectPath: '/repo', visible: true })
    await landFork(0, fork('f1'))
    expect(result.current.branchLoading).toBe(true)
    expect(result.current.forkPoint).toBeNull()

    await advance(5_000)
    await landAllFork('/wt2', fork('f2'))
    expect(result.current.branchLoading).toBe(false)
    expect(result.current.forkPoint).toBe('f2')
  })

  it("a checkout change: the old checkout's late failure does not end branchLoading", async () => {
    vi.useFakeTimers()
    const { result, rerender } = setup()
    await flush()
    rerender({ task: taskWith({ worktree_path: '/wt2' }), projectPath: '/repo', visible: true })
    await act(async () => {
      forkCalls[0].d.reject(new Error('git failed'))
    })
    expect(result.current.branchLoading).toBe(true)
  })

  it("a checkout change: the old checkout's late comparison does not replace the new one's", async () => {
    vi.useFakeTimers()
    const { result, rerender } = setup()
    await flush()
    await landFork(0, fork('f1'))
    await advance(5_000) // poll tick: a second /wt1 read, held in flight
    expect(forkFor('/wt1')).toHaveLength(2)

    rerender({ task: taskWith({ worktree_path: '/wt2' }), projectPath: '/repo', visible: true })
    // A pull re-reads the comparison now, whatever the poll does.
    mutationResults.pull = { success: true }
    await act(async () => {
      await result.current.handleAction('pull')
    })
    await landAllFork('/wt2', fork('f2'))
    expect(result.current.forkPoint).toBe('f2')

    await landFork(1, fork('f9'))
    expect(result.current.forkPoint).toBe('f2')
  })

  it('a checkout change reads the new checkout at once, even while backed off', async () => {
    vi.useFakeTimers()
    const { result, rerender } = setup()
    await flush()
    await landFork(0, fork('f1'))
    for (const [i, delay] of [5_000, 10_000, 20_000].entries()) {
      await advance(delay)
      await landFork(i + 1, fork('f1'))
    }
    await advance(1_000)
    rerender({ task: taskWith({ worktree_path: '/wt2' }), projectPath: '/repo', visible: true })
    await flush()
    expect(forkFor('/wt2')).toHaveLength(1)
    await landAllFork('/wt2', fork('f2'))
    expect(result.current.forkPoint).toBe('f2')
    await advance(4_999)
    expect(forkFor('/wt2')).toHaveLength(1)
    await advance(1)
    expect(forkFor('/wt2')).toHaveLength(2)
  })

  it('a parent branch change compares against the new parent at once', async () => {
    vi.useFakeTimers()
    const { result, rerender } = setup()
    await flush()
    await landFork(0, fork('f1'))
    await advance(5_000)
    await landFork(1, fork('f1')) // backed off to 10s
    await advance(1_000)
    rerender({
      task: taskWith({ worktree_parent_branch: 'develop' }),
      projectPath: '/repo',
      visible: true
    })
    await flush()
    expect(forkFor('/wt1', 'develop')).toHaveLength(1)
    await landAllFork('/wt1', fork('d1'), 'develop')
    expect(result.current.forkPoint).toBe('d1')
  })
})
