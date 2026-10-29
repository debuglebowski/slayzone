// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

type QueryOpts = { proc: string; input: { taskId: string }; enabled?: boolean }

// Stable data per (procedure, task) — the hook mirrors query data into state.
const DATA: Record<string, unknown[]> = {
  'getByTask:t1': [{ id: 'a1', task_id: 't1', title: 'one.md', folder_id: null }],
  'foldersGetByTask:t1': [{ id: 'f1', task_id: 't1', name: 'docs', parent_id: null }],
  'getByTask:t2': [{ id: 'a2', task_id: 't2', title: 'two.md', folder_id: null }],
  'foldersGetByTask:t2': []
}

vi.mock('./trpc', () => {
  const procedure = (proc: string) => ({
    queryOptions: (input: { taskId: string }, opts?: { enabled?: boolean }) => ({
      proc,
      input,
      enabled: opts?.enabled
    }),
    mutationOptions: () => ({})
  })
  const artifacts = new Proxy({}, { get: (_t, proc: string) => procedure(proc) })
  return { useTRPC: () => ({ artifacts }) }
})

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ proc, input, enabled }: QueryOpts) => ({
    data: enabled ? DATA[`${proc}:${input.taskId}`] : undefined,
    isPending: false
  }),
  useMutation: () => ({ mutateAsync: vi.fn() }),
  useQueryClient: () => ({})
}))

vi.mock('@slayzone/telemetry/client', () => ({ track: vi.fn() }))

import { useArtifacts } from './useArtifacts'

describe('useArtifacts task switches', () => {
  it('mirrors the task lists, clears them when the task goes away, reloads for the next task', async () => {
    const { result, rerender } = renderHook(({ taskId }) => useArtifacts(taskId), {
      initialProps: { taskId: 't1' as string | null }
    })
    await waitFor(() => expect(result.current.artifacts.map((a) => a.id)).toEqual(['a1']))
    expect(result.current.folders.map((f) => f.id)).toEqual(['f1'])

    rerender({ taskId: null })
    expect(result.current.artifacts).toEqual([])
    expect(result.current.folders).toEqual([])

    rerender({ taskId: 't2' })
    await waitFor(() => expect(result.current.artifacts.map((a) => a.id)).toEqual(['a2']))
    expect(result.current.folders).toEqual([])
  })

  it('starts empty without a task', () => {
    const { result } = renderHook(() => useArtifacts(null))
    expect(result.current.artifacts).toEqual([])
    expect(result.current.folders).toEqual([])
  })
})
