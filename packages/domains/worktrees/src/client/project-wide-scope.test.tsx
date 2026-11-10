// @vitest-environment jsdom
// Review 2, B1: the git panel's Worktrees tab works on the panel's whole PROJECT —
// every worktree of it, another task's or none's. In a TASK's panel its
// `worktrees.*` calls name the task with `projectWide` (the hub then runs them in the
// task's project's path scope, on the task's computer); everything else in the panel
// keeps the task's own scope. A project's panel is the project scope already.
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WorkspaceTargetProvider } from '@slayzone/file-editor/client/workspace-target'

const seen: Array<[string, unknown]> = []
const proc = (name: string) => ({
  queryOptions: (input: unknown, opts?: object) => {
    seen.push([name, input])
    return { ...opts, queryKey: [name, input], queryFn: async () => [], enabled: false }
  },
  mutationOptions: () => ({
    mutationFn: async (input: unknown) => {
      seen.push([name, input])
    }
  })
})
const ns = new Proxy({}, { get: (_t, name: string) => proc(name) })
const root = { worktrees: ns }
vi.mock('@slayzone/transport/client', () => ({
  typedTrpc: () => ({ useTRPC: () => root, useTRPCClient: () => root }),
  useTRPC: () => root,
  useTRPCClient: () => root
}))

const { useTRPC, ProjectWideGitScope } = await import('./trpc')

const panel =
  (target: { taskId?: string; projectId?: string }, projectWide: boolean) =>
  ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceTargetProvider target={target}>
        {projectWide ? <ProjectWideGitScope>{children}</ProjectWideGitScope> : children}
      </WorkspaceTargetProvider>
    </QueryClientProvider>
  )

afterEach(() => {
  cleanup()
  seen.length = 0
})

describe('the Worktrees tab scope', () => {
  it("in a task's panel: the task, project-wide — queries and mutations", async () => {
    const { result } = renderHook(() => useTRPC(), { wrapper: panel({ taskId: 't1' }, true) })
    result.current.worktrees.isDirty.queryOptions({ path: '/wt/b' })
    await result.current.worktrees.removeWorktree
      .mutationOptions()
      .mutationFn?.({ repoPath: '/p', worktreePath: '/wt/b' } as never, undefined as never)
    expect(seen).toEqual([
      [
        'isDirty',
        { path: '/wt/b', target: { taskId: 't1', computerId: undefined, projectWide: true } }
      ],
      [
        'removeWorktree',
        {
          repoPath: '/p',
          worktreePath: '/wt/b',
          target: { taskId: 't1', computerId: undefined, projectWide: true }
        }
      ]
    ])
  })

  it("the rest of a task's panel keeps the task's own scope", () => {
    const { result } = renderHook(() => useTRPC(), { wrapper: panel({ taskId: 't1' }, false) })
    result.current.worktrees.isDirty.queryOptions({ path: '/wt/a' })
    expect(seen).toEqual([
      ['isDirty', { path: '/wt/a', target: { taskId: 't1', computerId: undefined } }]
    ])
  })

  it("a project's panel is the project scope already", () => {
    const { result } = renderHook(() => useTRPC(), { wrapper: panel({ projectId: 'p1' }, true) })
    result.current.worktrees.isDirty.queryOptions({ path: '/wt/a' })
    expect(seen).toEqual([
      ['isDirty', { path: '/wt/a', target: { projectId: 'p1', computerId: undefined } }]
    ])
  })
})
