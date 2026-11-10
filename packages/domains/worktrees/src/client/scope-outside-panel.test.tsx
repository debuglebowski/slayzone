// @vitest-environment jsdom
// Callers OUTSIDE any task / project panel (App-level hooks such as useProjectRepos)
// must never throw while rendering: a missing path scope is the hub's refusal (a
// query error), never an uncaught render exception. Regression: the scoped proxy's
// `withScope` threw from `queryOptions` and took the whole App down.
import type React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { vi } from 'vitest'

const seen: Array<[string, unknown]> = []
const proc = (name: string) => ({
  queryOptions: (input: unknown, opts?: object) => {
    seen.push([name, input])
    return { ...opts, queryKey: [name, input], queryFn: async () => [], enabled: false }
  },
  mutationOptions: () => ({ mutationFn: async () => undefined }),
  subscriptionOptions: (input: unknown) => {
    seen.push([name, input])
    return {}
  }
})
const ns = new Proxy({}, { get: (_t, name: string) => proc(name) })
const root = { worktrees: ns, fileEditor: ns, workspace: ns }
vi.mock('@slayzone/transport/client', () => ({
  typedTrpc: () => ({ useTRPC: () => root, useTRPCClient: () => root }),
  useTRPC: () => root,
  useTRPCClient: () => root,
  useSubscription: () => undefined,
  useResubscribeOnComputerConnect: () => undefined
}))

const { useTRPC } = await import('./trpc')
const { useProjectRepos } = await import('./useProjectRepos')
const { useDetectedRepos } = await import('./useDetectedRepos')
const { useWatchedFile } = await import('@slayzone/file-editor/client/useWatchedFile')

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
)

afterEach(() => {
  cleanup()
  seen.length = 0
})

describe('worktrees / file editor callers outside any scope provider', () => {
  it('App-level useProjectRepos renders (with and without a project)', () => {
    expect(() => renderHook(() => useProjectRepos('/p', null, 'p1'), { wrapper })).not.toThrow()
    expect(seen).toContainEqual([
      'listProjectRepos',
      { projectPath: '/p', projectId: 'p1', opts: { taskBoundPath: null } }
    ])
    expect(() => renderHook(() => useProjectRepos('/p', null), { wrapper })).not.toThrow()
    expect(() => renderHook(() => useDetectedRepos('/p'), { wrapper })).not.toThrow()
  })

  it('a scoped proc built outside a panel goes out unscoped (the hub refuses), no throw', () => {
    expect(() =>
      renderHook(() => useTRPC().worktrees.getCurrentBranch.queryOptions({ path: '/p' }), {
        wrapper
      })
    ).not.toThrow()
    expect(seen).toContainEqual(['getCurrentBranch', { path: '/p' }])
  })

  it('useWatchedFile outside a panel renders and subscribes to nothing', () => {
    expect(() =>
      renderHook(
        () =>
          useWatchedFile({
            projectPath: '/p',
            relPath: 'a.md',
            read: async () => null,
            save: async () => {}
          }),
        { wrapper }
      )
    ).not.toThrow()
    expect(seen.some(([name, input]) => name === 'watch' && typeof input === 'object')).toBe(false)
  })
})
