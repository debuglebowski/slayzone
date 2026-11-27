// @vitest-environment jsdom
// The repo list is the project's, whoever views it: which entry is the task's
// (`isTaskBound`) is viewer state, flagged here. Keyed by the task's worktree path,
// the list was fetched afresh the moment that path arrived — the git panel showed
// no list (and jumped to another repo) for a round trip on every worktree task.
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const fetched: unknown[] = []
const REPOS = [
  { name: 'root', path: '/p', isTaskBound: false },
  { name: 'child', path: '/p/child', isTaskBound: false }
]
const proc = (name: string) => ({
  queryOptions: (input: unknown, opts?: object) => ({
    ...opts,
    queryKey: [name, input],
    queryFn: async () => {
      fetched.push(input)
      return REPOS
    }
  })
})
const root = { worktrees: new Proxy({}, { get: (_t, name: string) => proc(name) }) }
vi.mock('@slayzone/transport/client', () => ({
  typedTrpc: () => ({ useTRPC: () => root, useTRPCClient: () => root }),
  useTRPC: () => root,
  useTRPCClient: () => root
}))

vi.mock('./trpc', async () => (await import('./trpc.passthrough-mock')).trpcPassthroughMock())

const { useProjectRepos } = await import('./useProjectRepos')

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)
afterEach(() => {
  cleanup()
  client.clear()
  fetched.length = 0
})

describe('useProjectRepos', () => {
  it("the task's path arriving flags its entry, without fetching the list again", async () => {
    const hook = renderHook(
      ({ bound }: { bound: string | null }) => useProjectRepos('/p', bound, 'p1'),
      { wrapper, initialProps: { bound: null as string | null } }
    )
    await waitFor(() =>
      expect(hook.result.current.repos.map((r) => r.isTaskBound)).toEqual([false, false])
    )

    hook.rerender({ bound: '/p/child' })
    expect(hook.result.current.repos.map((r) => r.isTaskBound)).toEqual([false, true])
    await new Promise((r) => setTimeout(r, 10))
    expect(fetched).toHaveLength(1)
  })

  it('says when the list has answered', async () => {
    const hook = renderHook(() => useProjectRepos('/p', null, 'p1'), { wrapper })
    expect(hook.result.current.settled).toBe(false)
    await waitFor(() => expect(hook.result.current.settled).toBe(true))
  })

  it('a refetch of the same list (another page of the project mounting) re-renders nobody', async () => {
    // Every open task page of a project observes this one list: reading its fetch
    // status re-rendered all of them each time one more page mounted (117 e2e).
    let renders = 0
    const hook = renderHook(
      () => {
        renders += 1
        return useProjectRepos('/p', null, 'p1')
      },
      { wrapper }
    )
    await waitFor(() => expect(hook.result.current.settled).toBe(true))
    const settledRenders = renders
    await client.refetchQueries()
    await new Promise((r) => setTimeout(r, 10))
    expect(fetched).toHaveLength(2)
    expect(renders).toBe(settledRenders)
  })

  it('no project: nothing to wait for', () => {
    const hook = renderHook(() => useProjectRepos(null, null, 'p1'), { wrapper })
    expect(hook.result.current.settled).toBe(true)
  })
})
