// @vitest-environment jsdom
// Pins useConsolidatedGeneralData's worktree/branch action handlers: they keep one
// identity across re-renders (the REAL TanStack useMutation returns a new result object
// every render, so depending on it re-created them each time), and they still issue
// the same mutations.
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Task, UpdateTaskInput } from '@slayzone/task/shared'

const toast = vi.fn()
// The pollers run once on mount (no timers): enough to load the task branch.
vi.mock('@slayzone/ui', async () => {
  const { useEffect } = await import('react')
  return {
    toast: (m: string) => toast(m),
    useStablePoll: (fn: () => Promise<unknown>, o: { enabled: boolean }) => {
      useEffect(() => {
        if (o.enabled) void fn()
      }, [])
    }
  }
})

// Every trpc.<router>.<proc> exposes the option builders (query options keep their
// `enabled` etc.; the QueryClient's default queryFn answers them); mutations log
// their input.
const calls: Array<[string, unknown]> = []
const mutationResults: Record<string, unknown> = {}
const procs = new Proxy(
  {},
  {
    get: (_t, name: string) => ({
      queryOptions: (input: unknown, opts?: object) => ({ ...opts, queryKey: [name, input] }),
      mutationOptions: () => ({
        mutationFn: async (input: unknown) => {
          calls.push([name, input])
          return mutationResults[name]
        }
      })
    })
  }
)
const trpc = { worktrees: procs, settings: procs }
vi.mock('@slayzone/transport/client', () => ({ useTRPC: () => trpc }))

const { useConsolidatedGeneralData } = await import('./useConsolidatedGeneralData')

const task = {
  id: 'task-0001',
  title: 'My task',
  project_id: 'p1',
  worktree_path: '/wt',
  worktree_parent_branch: 'main',
  base_dir: null,
  pr_url: null
} as unknown as Task

const queryResults: Record<string, unknown> = {
  getCurrentBranch: 'feature',
  getWorktreeMetadata: null,
  getPrForCheckout: null,
  'settings.get': null,
  resolveCopyBehavior: { behavior: 'none' }
}

afterEach(() => {
  cleanup()
  calls.length = 0
  toast.mockReset()
})

/** A QueryClient whose fetchQuery and useQuery both answer through `fetch`. */
function mockClient(fetch: (key: string, input: unknown) => Promise<unknown>): QueryClient {
  const byKey = ({ queryKey }: { queryKey: readonly unknown[] }) =>
    fetch(String(queryKey[0]), queryKey[1])
  const client = new QueryClient({
    defaultOptions: {
      queries: { queryFn: byKey as never, retry: false },
      mutations: { retry: false }
    }
  })
  vi.spyOn(client, 'fetchQuery').mockImplementation(byKey as never)
  return client
}

async function setup() {
  const client = mockClient(async (key) => queryResults[key] ?? null)
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const onUpdateTask = vi.fn(async (_d: UpdateTaskInput) => task)
  const hook = renderHook(
    () => useConsolidatedGeneralData(task, '/repo', true, 5000, onUpdateTask),
    { wrapper }
  )
  await act(async () => {})
  return { ...hook, onUpdateTask }
}

describe('useConsolidatedGeneralData — action handlers', () => {
  it('keep one identity across re-renders', async () => {
    const { result, rerender } = await setup()
    const first = result.current
    rerender()
    rerender()
    expect(result.current.handleAddWorktree).toBe(first.handleAddWorktree)
    expect(result.current.handleAddWorktreeFromBranch).toBe(first.handleAddWorktreeFromBranch)
    expect(result.current.handleAction).toBe(first.handleAction)
  })

  it('branch actions run the matching mutation on the task worktree', async () => {
    const { result } = await setup()
    mutationResults.rebaseOnto = { success: true }
    mutationResults.mergeFrom = { success: true }
    mutationResults.mergeIntoParent = { success: true }
    mutationResults.push = { success: true }
    mutationResults.pull = { success: true }
    for (const a of ['rebase', 'merge', 'mergeToParent', 'push', 'pull']) {
      await act(() => result.current.handleAction(a))
    }
    expect(calls).toEqual([
      ['rebaseOnto', { path: '/wt', ontoBranch: 'main' }],
      ['mergeFrom', { path: '/wt', branch: 'main' }],
      ['mergeIntoParent', { projectPath: '/repo', parentBranch: 'main', sourceBranch: 'feature' }],
      ['push', { path: '/wt', branch: 'feature' }],
      ['pull', { path: '/wt' }]
    ])
    expect(toast.mock.calls.map((c) => c[0])).toEqual([
      'Rebase complete',
      'Merged main',
      'Merged into main',
      'Pushed',
      'Pulled'
    ])
  })

  it('creating a worktree from a branch issues createWorktree and links it', async () => {
    const { result, onUpdateTask } = await setup()
    await act(() => result.current.handleAddWorktreeFromBranch('feat/x'))
    expect(calls).toEqual([
      [
        'createWorktree',
        expect.objectContaining({ repoPath: '/repo', sourceBranch: 'feat/x', projectId: 'p1' })
      ]
    ])
    expect(onUpdateTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-0001', worktreeParentBranch: null })
    )
  })
})

// The reactive fetches (worktree branch, PR, metadata, detected worktrees): a
// response for previous inputs that lands after the inputs changed is dropped, so it
// can never replace the current inputs' data.
describe('useConsolidatedGeneralData — out-of-date responses', () => {
  type Pending = { key: string; input: unknown; resolve: (v: unknown) => void }
  let pending: Pending[] = []

  // Every fetch for a `deferred` procedure waits until the test resolves it; the
  // rest answer from queryResults right away.
  async function setupWithProps(deferred: string[], initial: { task: Task; projectPath: string }) {
    pending = []
    const client = mockClient((key, input) => {
      if (!deferred.includes(key)) return Promise.resolve(queryResults[key] ?? null)
      return new Promise((resolve) => pending.push({ key, input, resolve }))
    })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const hook = renderHook(
      (p: { task: Task; projectPath: string }) =>
        useConsolidatedGeneralData(p.task, p.projectPath, true, 5000, async () => p.task),
      { wrapper, initialProps: initial }
    )
    // Let the immediate fetches land (e.g. the worktree branch the PR fetch keys on).
    await act(async () => {})
    return hook
  }
  // Answers every pending fetch of `key` for `input`.
  const take = (key: string, input: unknown) => {
    const matching = pending.filter(
      (x) => x.key === key && JSON.stringify(x.input) === JSON.stringify(input)
    )
    if (matching.length === 0) throw new Error(`no pending ${key} ${JSON.stringify(input)}`)
    return { resolve: (v: unknown) => matching.forEach((x) => x.resolve(v)) }
  }
  // No branch comparison: keeps fetchBranchData's own getCurrentBranch calls out.
  const wtTask = (over: Partial<Task>) =>
    ({ ...task, worktree_parent_branch: null, ...over }) as unknown as Task

  it('worktree branch: a late response for the previous worktree path is dropped', async () => {
    const { result, rerender } = await setupWithProps(['getCurrentBranch'], {
      task: wtTask({ worktree_path: '/wt1' }),
      projectPath: '/repo'
    })
    rerender({ task: wtTask({ worktree_path: '/wt2' }), projectPath: '/repo' })
    await act(async () => take('getCurrentBranch', { path: '/wt2' }).resolve('b2'))
    expect(result.current.worktreeBranch).toBe('b2')
    await act(async () => take('getCurrentBranch', { path: '/wt1' }).resolve('b1'))
    expect(result.current.worktreeBranch).toBe('b2')
  })

  it('worktree branch: a late response is dropped once the worktree is unlinked', async () => {
    const { result, rerender } = await setupWithProps(['getCurrentBranch'], {
      task: wtTask({ worktree_path: '/wt1' }),
      projectPath: '/repo'
    })
    rerender({ task: wtTask({ worktree_path: null }), projectPath: '/repo' })
    await act(async () => take('getCurrentBranch', { path: '/wt1' }).resolve('b1'))
    expect(result.current.worktreeBranch).toBe(null)
  })

  it('metadata: a late response for the previous worktree path is dropped', async () => {
    const { result, rerender } = await setupWithProps(['getWorktreeMetadata'], {
      task: wtTask({ worktree_path: '/wt1' }),
      projectPath: '/repo'
    })
    rerender({ task: wtTask({ worktree_path: '/wt2' }), projectPath: '/repo' })
    const m2 = { createdAt: 'two' }
    await act(async () => take('getWorktreeMetadata', { path: '/wt2' }).resolve(m2))
    expect(result.current.metadata).toBe(m2)
    await act(async () =>
      take('getWorktreeMetadata', { path: '/wt1' }).resolve({ createdAt: 'one' })
    )
    expect(result.current.metadata).toBe(m2)
  })

  it('PR: a late response for the previous PR url is dropped', async () => {
    const { result, rerender } = await setupWithProps(['getPrByUrl'], {
      task: wtTask({ worktree_path: '/wt1', pr_url: 'https://x/pr/1' }),
      projectPath: '/repo'
    })
    rerender({
      task: wtTask({ worktree_path: '/wt1', pr_url: 'https://x/pr/2' }),
      projectPath: '/repo'
    })
    // A useQuery result reaches React on react-query's next-macrotask notify.
    const answer = (url: string, pr: unknown) =>
      act(async () => {
        take('getPrByUrl', { repoPath: '/repo', url }).resolve(pr)
        await new Promise((r) => setTimeout(r, 0))
      })
    const pr2 = { number: 2 }
    await answer('https://x/pr/2', pr2)
    expect(result.current.pr).toBe(pr2)
    await answer('https://x/pr/1', { number: 1 })
    expect(result.current.pr).toBe(pr2)
  })

  it('detected worktrees: a late response for the previous repo is dropped', async () => {
    const { result, rerender } = await setupWithProps(['detectWorktrees'], {
      task: wtTask({ worktree_path: null }),
      projectPath: '/repo1'
    })
    rerender({ task: wtTask({ worktree_path: null }), projectPath: '/repo2' })
    const wt = (path: string) => ({ path, branch: 'b', isMain: false })
    await act(async () => take('detectWorktrees', { repoPath: '/repo2' }).resolve([wt('/two')]))
    expect(result.current.detectedWorktrees).toEqual([wt('/two')])
    await act(async () => take('detectWorktrees', { repoPath: '/repo1' }).resolve([wt('/one')]))
    expect(result.current.detectedWorktrees).toEqual([wt('/two')])
  })

  it('detected worktrees: a late response is dropped once a worktree is linked', async () => {
    const { result, rerender } = await setupWithProps(['detectWorktrees'], {
      task: wtTask({ worktree_path: null }),
      projectPath: '/repo'
    })
    rerender({ task: wtTask({ worktree_path: '/wt' }), projectPath: '/repo' })
    await act(async () =>
      take('detectWorktrees', { repoPath: '/repo' }).resolve([
        { path: '/one', branch: 'b', isMain: false }
      ])
    )
    expect(result.current.detectedWorktrees).toEqual([])
  })
})

// The worktree branch and the detected (linkable) worktrees are cleared when their
// source goes away: no linked worktree → no worktree branch; a linked worktree or no
// project path → no detected worktrees.
describe('useConsolidatedGeneralData — resets', () => {
  type P = { task: Task; projectPath: string | null }
  async function setupResets(initial: P, results: Record<string, unknown>) {
    const client = new QueryClient()
    vi.spyOn(client, 'fetchQuery').mockImplementation((async (o: { queryKey: unknown[] }) => {
      const key = String(o.queryKey[0])
      return key in results ? results[key] : (queryResults[key] ?? null)
    }) as never)
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const hook = renderHook(
      (p: P) => useConsolidatedGeneralData(p.task, p.projectPath, true, 5000, async () => p.task),
      { wrapper, initialProps: initial }
    )
    await act(async () => {})
    return hook
  }
  const t = (over: Partial<Task>) =>
    ({ ...task, worktree_parent_branch: null, ...over }) as unknown as Task
  const wt = (path: string) => ({ path, branch: 'b', isMain: false })

  it('unlinking the worktree clears the worktree branch', async () => {
    const { result, rerender } = await setupResets(
      { task: t({ worktree_path: '/wt1' }), projectPath: '/repo' },
      { getCurrentBranch: 'b1' }
    )
    expect(result.current.worktreeBranch).toBe('b1')
    rerender({ task: t({ worktree_path: null }), projectPath: '/repo' })
    expect(result.current.worktreeBranch).toBe(null)
    await act(async () => {})
    expect(result.current.worktreeBranch).toBe(null)
  })

  it('linking a worktree clears the detected worktrees', async () => {
    const { result, rerender } = await setupResets(
      { task: t({ worktree_path: null }), projectPath: '/repo' },
      { detectWorktrees: [wt('/one'), { path: '/repo', branch: 'main', isMain: true }] }
    )
    expect(result.current.detectedWorktrees).toEqual([wt('/one')])
    rerender({ task: t({ worktree_path: '/wt' }), projectPath: '/repo' })
    expect(result.current.detectedWorktrees).toEqual([])
    // Unlinking again re-detects.
    rerender({ task: t({ worktree_path: null }), projectPath: '/repo' })
    await act(async () => {})
    expect(result.current.detectedWorktrees).toEqual([wt('/one')])
  })

  it('losing the project path clears the detected worktrees', async () => {
    const { result, rerender } = await setupResets(
      { task: t({ worktree_path: null }), projectPath: '/repo' },
      { detectWorktrees: [wt('/one')] }
    )
    expect(result.current.detectedWorktrees).toEqual([wt('/one')])
    rerender({ task: t({ worktree_path: null }), projectPath: null })
    expect(result.current.detectedWorktrees).toEqual([])
  })
})

// "Not a git repository" must mean git said so. A failed CHECK (the machine could not
// start git) is reported as gitError, so the panel says "Git unavailable" instead of
// offering `git init` on a healthy repo.
describe('useConsolidatedGeneralData — repo check failure', () => {
  async function setupIsGitRepo(answer: () => Promise<unknown>) {
    const client = new QueryClient()
    vi.spyOn(client, 'fetchQuery').mockImplementation(((o: { queryKey: unknown[] }) => {
      const key = String(o.queryKey[0])
      if (key === 'isGitRepo') return answer()
      return Promise.resolve(queryResults[key] ?? null)
    }) as never)
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const hook = renderHook(
      () => useConsolidatedGeneralData(task, '/repo', true, 5000, async () => task),
      { wrapper }
    )
    await act(async () => {})
    return hook
  }

  it('a check that throws sets gitError and leaves isGitRepo unknown', async () => {
    const { result } = await setupIsGitRepo(() =>
      Promise.reject(new Error('Could not start git: spawn git EMFILE'))
    )
    expect(result.current.gitError).toBe('Could not start git: spawn git EMFILE')
    expect(result.current.isGitRepo).toBeNull()
  })

  it('git answering no is "not a repo", with no gitError', async () => {
    const { result } = await setupIsGitRepo(() => Promise.resolve(false))
    expect(result.current.isGitRepo).toBe(false)
    expect(result.current.gitError).toBeNull()
  })
})
