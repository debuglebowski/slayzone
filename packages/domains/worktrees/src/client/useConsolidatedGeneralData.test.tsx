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

// Every trpc.<router>.<proc> exposes the option builders; mutations log their input.
const calls: Array<[string, unknown]> = []
const mutationResults: Record<string, unknown> = {}
const procs = new Proxy(
  {},
  {
    get: (_t, name: string) => ({
      queryOptions: (input: unknown) => ({ queryKey: [name, input] }),
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
  listOpenPrs: [],
  'settings.get': null,
  resolveCopyBehavior: { behavior: 'none' }
}

afterEach(() => {
  cleanup()
  calls.length = 0
  toast.mockReset()
})

async function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  vi.spyOn(client, 'fetchQuery').mockImplementation(
    (async (o: { queryKey: unknown[] }) => queryResults[String(o.queryKey[0])] ?? null) as never
  )
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
