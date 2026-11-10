// @vitest-environment jsdom
// A task's paths are read from its computer (robustness plan §9, Phase 7d): every
// render-time user (the task page, the board/sidebar colour lookup, the App-level
// tab placement) must get a state — loading, ok, offline — and NEVER throw while
// rendering: not before the task loads, not without any panel/hub scope around it,
// not while its computer is away, not when the read itself fails.
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

type Answer = Record<string, unknown>
const calls: string[][] = []
let respond: (ids: string[]) => Promise<Answer> = async () => ({})
const client = {
  task: {
    paths: {
      query: ({ taskIds }: { taskIds: string[] }) => {
        calls.push(taskIds)
        return respond(taskIds)
      }
    }
  },
  computers: {
    list: { queryOptions: () => ({ queryKey: ['computers'], queryFn: async () => [] }) }
  }
}
vi.mock('./trpc', () => ({ useClientForTask: () => client, useTRPC: () => client }))
vi.mock('@slayzone/transport/client', () => ({
  getClientForHub: () => client,
  getHubIdForTask: () => undefined
}))

const { useTaskPath, useTaskWorktreePaths, peekTaskPath, taskPathQueryKey } = await import(
  './useTaskPath'
)

let qc = new QueryClient()
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
)
const task = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    has_worktree: true,
    has_base_dir: false,
    updated_at: '2026-11-10 10:00:00',
    computer_id: 'pc',
    worktree_computer_id: null,
    ...over
  }) as never

afterEach(() => {
  cleanup()
  calls.length = 0
  qc = new QueryClient()
  respond = async () => ({})
})

describe('useTaskPath', () => {
  it('no task yet: loading, no read, no throw', () => {
    const { result } = renderHook(() => useTaskPath(null), { wrapper })
    expect(result.current).toEqual({ state: 'loading' })
    expect(calls).toEqual([])
  })

  it('no folder of its own: answered at once without asking the computer', () => {
    const { result } = renderHook(
      () => useTaskPath(task('t', { has_worktree: false, has_base_dir: false })),
      { wrapper }
    )
    expect(result.current).toEqual({ state: 'ok', worktreePath: null, baseDir: null })
    expect(calls).toEqual([])
  })

  it("loading, then the computer's answer; rows rendered together are ONE batched read", async () => {
    respond = async (ids) =>
      Object.fromEntries(
        ids.map((id) => [id, { state: 'ok', worktreePath: `/w/${id}`, baseDir: null }])
      )
    const { result } = renderHook(() => [useTaskPath(task('a')), useTaskPath(task('b'))], {
      wrapper
    })
    expect(result.current[0]).toEqual({ state: 'loading' })
    await waitFor(() =>
      expect(result.current[1]).toEqual({ state: 'ok', worktreePath: '/w/b', baseDir: null })
    )
    expect(calls).toEqual([['a', 'b']])
    expect(peekTaskPath(qc, task('a'))).toEqual({
      state: 'ok',
      worktreePath: '/w/a',
      baseDir: null
    })
  })

  it('computer away: offline, naming the computer (else the one that made the worktree)', async () => {
    respond = async () => ({ a: { state: 'offline', computerId: null } })
    const { result } = renderHook(() => useTaskPath(task('a', { worktree_computer_id: 'wt-pc' })), {
      wrapper
    })
    await waitFor(() => expect(result.current).toEqual({ state: 'offline', computerId: 'wt-pc' }))
  })

  it('the read itself fails: offline, never a throw at render', async () => {
    respond = async () => {
      throw new Error('socket closed')
    }
    const { result } = renderHook(() => useTaskPath(task('a')), { wrapper })
    await waitFor(() => expect(result.current.state).toBe('offline'))
  })

  it('a changed row (new version) is read again', async () => {
    let n = 0
    respond = async (ids) =>
      Object.fromEntries(
        ids.map((id) => [id, { state: 'ok', worktreePath: `/w${++n}`, baseDir: null }])
      )
    const { result, rerender } = renderHook(({ t }) => useTaskPath(t), {
      wrapper,
      initialProps: { t: task('a') }
    })
    await waitFor(() => expect(result.current).toMatchObject({ worktreePath: '/w1' }))
    rerender({ t: task('a', { updated_at: '2026-11-10 10:00:05' }) })
    await waitFor(() => expect(result.current).toMatchObject({ worktreePath: '/w2' }))
    expect(taskPathQueryKey(task('a'))).not.toEqual(
      taskPathQueryKey(task('a', { updated_at: 'x' }))
    )
  })
})

describe('useTaskWorktreePaths (board / sidebar level)', () => {
  it('only tasks with a worktree are read; unknown ones are absent, never "none"', async () => {
    respond = async () => ({
      a: { state: 'ok', worktreePath: '/w/a', baseDir: null },
      c: { state: 'offline', computerId: 'pc' }
    })
    const tasks = [task('a'), task('b', { has_worktree: false }), task('c')]
    const { result } = renderHook(() => useTaskWorktreePaths(tasks), { wrapper })
    expect(result.current.size).toBe(0)
    await waitFor(() => expect([...result.current]).toEqual([['a', '/w/a']]))
    expect(calls.flat().sort()).toEqual(['a', 'c'])
    // Same answers → the same Map (consumers memoize on it).
    const first = result.current
    await act(async () => {})
    expect(result.current).toBe(first)
  })
})
