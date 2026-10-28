// @vitest-environment jsdom
// Pins ConflictPhaseContent's merge completion: the "Complete Merge" handler keeps one
// identity across re-renders (the REAL TanStack useMutation returns a new result object
// every render, so depending on it re-created the handler each time), and completing a
// merge still commits with the merge message and clears the task's merge state.
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Task, UpdateTaskInput } from '@slayzone/task-contracts'

type Children = { children?: React.ReactNode }
const buttonHandlers = new Map<string, Set<unknown>>()
vi.mock('@slayzone/ui', () => ({
  Button: ({
    children,
    onClick,
    disabled
  }: Children & { onClick: () => void; disabled?: boolean }) => {
    const label = String(children)
    if (!buttonHandlers.has(label)) buttonHandlers.set(label, new Set())
    buttonHandlers.get(label)!.add(onClick)
    return (
      <button type="button" onClick={onClick} disabled={disabled}>
        {children}
      </button>
    )
  },
  Checkbox: () => null,
  cn: (...c: unknown[]) => c.filter(Boolean).join(' ')
}))
vi.mock('./ConflictFileView', () => ({
  ConflictFileView: ({ filePath, onResolved }: { filePath: string; onResolved: () => void }) => (
    <button type="button" onClick={onResolved}>
      resolve {filePath}
    </button>
  )
}))

const calls: Array<[string, unknown]> = []
const mutation = (name: string) => ({
  mutationOptions: () => ({
    mutationFn: async (input: unknown) => {
      calls.push([name, input])
    }
  })
})
const query = (name: string) => ({
  queryOptions: (input: unknown) => ({ queryKey: [name, input] })
})
const trpc = {
  worktrees: {
    commitFiles: mutation('commitFiles'),
    continueRebase: mutation('continueRebase'),
    skipRebaseCommit: mutation('skipRebaseCommit'),
    abortRebase: mutation('abortRebase'),
    abortMerge: mutation('abortMerge'),
    getMergeContext: query('getMergeContext'),
    getConflictedFiles: query('getConflictedFiles'),
    getCurrentBranch: query('getCurrentBranch')
  }
}
vi.mock('@slayzone/transport/client', () => ({ useTRPC: () => trpc }))

const { ConflictPhaseContent } = await import('./ConflictPhaseContent')

const task = {
  id: 't1',
  worktree_path: '/wt',
  worktree_parent_branch: 'main',
  terminal_mode: 'claude-code',
  merge_context: { type: 'merge', sourceBranch: 'feature', targetBranch: 'main' }
} as unknown as Task

const onToolbarChange = vi.fn()

afterEach(() => {
  cleanup()
  calls.length = 0
  buttonHandlers.clear()
})

async function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  vi.spyOn(client, 'fetchQuery').mockImplementation((async (o: { queryKey: unknown[] }) => {
    if (o.queryKey[0] === 'getConflictedFiles') return ['a.txt']
    if (o.queryKey[0] === 'getCurrentBranch') return 'feature'
    return null
  }) as never)
  const updated = { ...task, status: 'done' } as Task
  const onUpdateTask = vi.fn(async (_d: UpdateTaskInput) => updated)
  const onTaskUpdated = vi.fn()
  const el = () => (
    <QueryClientProvider client={client}>
      <ConflictPhaseContent
        task={task}
        projectPath="/repo"
        completedStatus="done"
        isRebase={false}
        onUpdateTask={onUpdateTask}
        onTaskUpdated={onTaskUpdated}
        onToolbarChange={onToolbarChange}
      />
    </QueryClientProvider>
  )
  const ui = render(el())
  await act(async () => {})
  return { ui, el, onUpdateTask, onTaskUpdated, updated }
}

describe('ConflictPhaseContent', () => {
  it('keeps one "Complete Merge" handler across re-renders', async () => {
    const { ui, el } = await setup()
    ui.rerender(el())
    ui.rerender(el())
    expect(buttonHandlers.get('Complete Merge')?.size).toBe(1)
  })

  it('completing a merge commits with the merge message and clears the merge state', async () => {
    const { onUpdateTask, onTaskUpdated, updated } = await setup()
    fireEvent.click(screen.getByText('resolve a.txt'))
    await act(async () => fireEvent.click(screen.getByText('Complete Merge')))
    expect(calls).toEqual([
      ['commitFiles', { repoPath: '/repo', message: 'Merge feature into main' }]
    ])
    expect(onUpdateTask).toHaveBeenLastCalledWith({
      id: 't1',
      mergeState: null,
      mergeContext: null,
      status: 'done'
    })
    expect(onTaskUpdated).toHaveBeenCalledWith(updated)
  })
})
