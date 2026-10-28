// @vitest-environment jsdom
// Pins useGitMergeActions: the merge handlers keep one identity across re-renders (the
// REAL TanStack useMutation returns a new result object every render, so depending on
// it re-created the handler each time), and commit-and-continue still runs
// stageAll → commitFiles → mergeWithAI and completes the task.
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Task, UpdateTaskInput } from '@slayzone/task-contracts'

const calls: Array<[string, unknown]> = []
const mutation = (name: string, result?: unknown) => ({
  mutationOptions: () => ({
    mutationFn: async (input: unknown) => {
      calls.push([name, input])
      return result
    }
  })
})
const query = (name: string) => ({
  queryOptions: (input: unknown) => ({ queryKey: [name, input] })
})
const trpc = {
  worktrees: {
    stageAll: mutation('stageAll'),
    commitFiles: mutation('commitFiles'),
    mergeWithAI: mutation('mergeWithAI', { success: true }),
    abortMerge: mutation('abortMerge'),
    getCurrentBranch: query('getCurrentBranch'),
    getMergeContext: query('getMergeContext')
  }
}
// The domain's typed view (`./trpc`) re-types the transport client: serve
// it the transport mock below.
vi.mock('./trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({ useTRPC: () => trpc }))

const { useGitMergeActions } = await import('./useGitMergeActions')

const task = {
  id: 't1',
  worktree_path: '/wt',
  worktree_parent_branch: 'main'
} as unknown as Task

afterEach(() => {
  cleanup()
  calls.length = 0
})

function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  vi.spyOn(client, 'fetchQuery').mockImplementation((async (o: { queryKey: unknown[] }) =>
    o.queryKey[0] === 'getCurrentBranch' ? 'feature' : null) as never)
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const updated = { ...task, status: 'done' } as Task
  const onUpdateTask = vi.fn(async (_d: UpdateTaskInput) => updated)
  const onTaskUpdated = vi.fn()
  const hook = renderHook(
    () =>
      useGitMergeActions({
        task,
        projectPath: '/repo',
        completedStatus: 'done',
        onUpdateTask,
        onTaskUpdated
      }),
    { wrapper }
  )
  return { ...hook, onUpdateTask, onTaskUpdated, updated }
}

describe('useGitMergeActions', () => {
  it('keeps one handler identity across re-renders', () => {
    const { result, rerender } = setup()
    const first = result.current
    rerender()
    rerender()
    expect(result.current.handleCommitAndContinueMerge).toBe(first.handleCommitAndContinueMerge)
    expect(result.current.handleAbortMerge).toBe(first.handleAbortMerge)
  })

  it('commit-and-continue stages, commits, merges with AI and completes the task', async () => {
    const { result, onUpdateTask, onTaskUpdated, updated } = setup()
    await act(() => result.current.handleCommitAndContinueMerge())
    expect(calls).toEqual([
      ['stageAll', { path: '/wt' }],
      ['commitFiles', { repoPath: '/wt', message: 'WIP: changes before merge' }],
      [
        'mergeWithAI',
        { projectPath: '/repo', worktreePath: '/wt', parentBranch: 'main', sourceBranch: 'feature' }
      ]
    ])
    expect(onUpdateTask).toHaveBeenCalledWith({
      id: 't1',
      status: 'done',
      mergeState: null,
      mergeContext: null
    })
    expect(onTaskUpdated).toHaveBeenCalledWith(updated)
  })
})
