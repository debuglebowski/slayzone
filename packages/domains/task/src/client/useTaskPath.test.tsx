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
    },
    // The hub's path-change event: the test fires it through `pathsChanged`.
    onPathsChanged: {
      subscriptionOptions: (_: unknown, opts: { onData: (e: { taskId: string }) => void }) => ({
        onData: opts.onData
      })
    }
  },
  computers: {
    list: { queryOptions: () => ({ queryKey: ['computers'], queryFn: async () => [] }) }
  }
}
let pathsChanged: ((e: { taskId: string }) => void) | null = null
vi.mock('./trpc', () => ({ useClientForTask: () => client, useTRPC: () => client }))
vi.mock('@slayzone/transport/client', () => ({
  getClientForHub: () => client,
  getHubIdForTask: () => undefined,
  useSubscription: (opts: { onData?: (e: { taskId: string }) => void }) => {
    if (opts.onData) pathsChanged = opts.onData
  }
}))

const {
  useTaskPath,
  useTaskWorktreePaths,
  peekTaskPath,
  taskPathQueryKey,
  resetTaskPath,
  useTaskPathChanges,
  useHeldTaskPath
} = await import('./useTaskPath')

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

  it('an unrelated row update (status, title, version) keeps the answer: no re-read, never loading (B2)', async () => {
    let n = 0
    respond = async (ids) =>
      Object.fromEntries(
        ids.map((id) => [id, { state: 'ok', worktreePath: `/w${++n}`, baseDir: null }])
      )
    const seen: string[] = []
    const { result, rerender } = renderHook(
      ({ t }) => {
        const view = useTaskPath(t)
        seen.push(view.state)
        return view
      },
      { wrapper, initialProps: { t: task('a') } }
    )
    await waitFor(() => expect(result.current).toMatchObject({ worktreePath: '/w1' }))
    seen.length = 0
    rerender({
      t: task('a', { updated_at: '2026-11-10 10:00:05', status: 'done', title: 'renamed' })
    })
    await act(async () => {})
    expect(result.current).toMatchObject({ state: 'ok', worktreePath: '/w1' })
    expect(seen).not.toContain('loading')
    expect(calls).toEqual([['a']])
    expect(taskPathQueryKey(task('a'))).toEqual(taskPathQueryKey(task('a', { updated_at: 'x' })))
  })

  it('a moved holder (worktree computer) or a flipped folder flag is read again', () => {
    const base = taskPathQueryKey(task('a'))
    expect(taskPathQueryKey(task('a', { worktree_computer_id: 'pc2' }))).not.toEqual(base)
    expect(taskPathQueryKey(task('a', { has_base_dir: true }))).not.toEqual(base)
    expect(taskPathQueryKey(task('a', { has_worktree: false }))).not.toEqual(base)
  })

  it("a path-change event drops the task's answer and reads it again (no stale path)", async () => {
    let n = 0
    respond = async (ids) =>
      Object.fromEntries(
        ids.map((id) => [id, { state: 'ok', worktreePath: `/w${++n}`, baseDir: null }])
      )
    const { result } = renderHook(() => useTaskPath(task('a')), { wrapper })
    await waitFor(() => expect(result.current).toMatchObject({ worktreePath: '/w1' }))
    await act(async () => {
      await resetTaskPath(qc, 'a')
    })
    await waitFor(() => expect(result.current).toMatchObject({ worktreePath: '/w2' }))
  })

  it('useTaskPathChanges: the hub naming a task resets only that task', async () => {
    respond = async (ids) =>
      Object.fromEntries(
        ids.map((id) => [id, { state: 'ok', worktreePath: `/${id}`, baseDir: null }])
      )
    const { result } = renderHook(
      () => {
        useTaskPathChanges()
        return [useTaskPath(task('a')), useTaskPath(task('b'))]
      },
      { wrapper }
    )
    await waitFor(() => expect(result.current[1]).toMatchObject({ worktreePath: '/b' }))
    calls.length = 0
    await act(async () => {
      pathsChanged?.({ taskId: 'a' })
    })
    await waitFor(() => expect(calls).toEqual([['a']]))
  })
})

describe('useHeldTaskPath (the task page: only the FIRST load gates the terminal)', () => {
  const ok = (p: string) => ({ state: 'ok' as const, worktreePath: p, baseDir: null })
  it('loading then ok: passes through; a later loading/offline keeps the last answer', () => {
    const { result, rerender } = renderHook(({ t, v }) => useHeldTaskPath(t, v), {
      initialProps: { t: task('a'), v: { state: 'loading' } as never }
    })
    expect(result.current).toEqual({ state: 'loading' })
    rerender({ t: task('a'), v: ok('/w') as never })
    expect(result.current).toEqual(ok('/w'))
    rerender({
      t: task('a', { status: 'done' }),
      v: { state: 'offline', computerId: 'pc' } as never
    })
    expect(result.current).toEqual(ok('/w'))
    rerender({ t: task('a'), v: { state: 'loading' } as never })
    expect(result.current).toEqual(ok('/w'))
    rerender({ t: task('a'), v: ok('/w2') as never })
    expect(result.current).toEqual(ok('/w2'))
  })

  it('never carries an answer over to another task, nor to a task whose folder flags changed', () => {
    const { result, rerender } = renderHook(({ t, v }) => useHeldTaskPath(t, v), {
      initialProps: { t: task('a'), v: ok('/w') as never }
    })
    rerender({ t: task('b'), v: { state: 'loading' } as never })
    expect(result.current).toEqual({ state: 'loading' })
    rerender({ t: task('b'), v: ok('/b') as never })
    rerender({
      t: task('b', { has_worktree: false, has_base_dir: true }),
      v: { state: 'loading' } as never
    })
    expect(result.current).toEqual({ state: 'loading' })
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
