// @vitest-environment jsdom
// The shared git-diff store serves EVERY git panel in the window. Each panel's diff
// read and fs watch must go out in THAT panel's path scope (§9 Phase 7b). The store
// used to wire its transport once, from the first panel to mount, through that
// panel's scoped `useTRPC()` — so every later panel's calls went out in the first
// panel's scope, and the computer refused them: "path '<project B folder>' is outside
// the folders of project <project A>; refused" (2026-11-11, Home git panel).
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WorkspaceTargetProvider } from '@slayzone/file-editor/client/workspace-target'

const seen: Array<[string, unknown]> = []
const proc = (name: string) => ({
  queryOptions: (input: unknown, opts?: object) => ({
    ...opts,
    queryKey: [name, input],
    queryFn: async () => {
      seen.push([name, input])
      return {
        targetPath: '',
        files: [],
        stagedFiles: [],
        unstagedFiles: [],
        untrackedFiles: [],
        unstagedPatch: '',
        stagedPatch: '',
        generatedAt: '',
        isGitRepo: true
      }
    }
  }),
  subscriptionOptions: () => ({}),
  mutate: async (input: unknown) => {
    seen.push([name, input])
  }
})
const ns = new Proxy({}, { get: (_t, name: string) => proc(name) })
const root = { worktrees: ns }
vi.mock('@slayzone/transport/client', () => ({
  typedTrpc: () => ({ useTRPC: () => root, useTRPCClient: () => root }),
  useTRPC: () => root,
  useTRPCClient: () => root,
  useSubscription: () => undefined
}))

const { useGitDiffSnapshot, useGitPathChanges, _resetStore, _setGitDiffStoreTransport } =
  await import('./git-diff-store')

const queryClient = new QueryClient()
const panel =
  (target: { taskId?: string; projectId?: string }) =>
  ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <WorkspaceTargetProvider target={target}>{children}</WorkspaceTargetProvider>
    </QueryClientProvider>
  )

const params = { ignoreWhitespace: false, pollIntervalMs: 60_000, visible: true }

beforeEach(() => {
  _resetStore()
  _setGitDiffStoreTransport(null)
})
afterEach(() => {
  cleanup()
  _resetStore()
  _setGitDiffStoreTransport(null)
  queryClient.clear()
  seen.length = 0
})

const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)))
const callsOf = (name: string) => seen.filter(([n]) => n === name).map(([, input]) => input)

describe('the git-diff store: each panel in its own scope', () => {
  it('a second panel (another project) reads its diff in ITS project, not the first', async () => {
    renderHook(() => useGitDiffSnapshot('/projects/a', params), {
      wrapper: panel({ projectId: 'p-a' })
    })
    await flush()
    renderHook(() => useGitDiffSnapshot('/projects/b', params), {
      wrapper: panel({ projectId: 'p-b' })
    })
    await flush()

    expect(callsOf('getWorkingDiff')).toEqual([
      expect.objectContaining({
        path: '/projects/a',
        target: expect.objectContaining({ projectId: 'p-a' })
      }),
      expect.objectContaining({
        path: '/projects/b',
        target: expect.objectContaining({ projectId: 'p-b' })
      })
    ])
    expect(callsOf('watchStart')).toEqual([
      expect.objectContaining({
        worktreePath: '/projects/a',
        target: expect.objectContaining({ projectId: 'p-a' })
      }),
      expect.objectContaining({
        worktreePath: '/projects/b',
        target: expect.objectContaining({ projectId: 'p-b' })
      })
    ])
  })

  it('the same folder in two scopes is read and watched once per scope, each in its own', async () => {
    renderHook(() => useGitDiffSnapshot('/projects/a', params), {
      wrapper: panel({ projectId: 'p-a' })
    })
    await flush()
    renderHook(() => useGitDiffSnapshot('/projects/a', params), {
      wrapper: panel({ taskId: 't-1' })
    })
    await flush()

    expect(callsOf('getWorkingDiff')).toEqual([
      expect.objectContaining({ target: expect.objectContaining({ projectId: 'p-a' }) }),
      expect.objectContaining({ target: expect.objectContaining({ taskId: 't-1' }) })
    ])
    expect(callsOf('watchStart')).toEqual([
      expect.objectContaining({ target: expect.objectContaining({ projectId: 'p-a' }) }),
      expect.objectContaining({ target: expect.objectContaining({ taskId: 't-1' }) })
    ])
  })

  it('a non-diff reader (useGitPathChanges) watches in its own scope too', async () => {
    renderHook(() => useGitDiffSnapshot('/projects/a', params), {
      wrapper: panel({ projectId: 'p-a' })
    })
    await flush()
    renderHook(() => useGitPathChanges('/projects/b', true, () => undefined), {
      wrapper: panel({ projectId: 'p-b' })
    })
    await flush()

    expect(callsOf('watchStart')).toEqual([
      expect.objectContaining({
        worktreePath: '/projects/a',
        target: expect.objectContaining({ projectId: 'p-a' })
      }),
      expect.objectContaining({
        worktreePath: '/projects/b',
        target: expect.objectContaining({ projectId: 'p-b' })
      })
    ])
  })

  it('the last one out stops the watch in the scope that started it', async () => {
    const first = renderHook(() => useGitDiffSnapshot('/projects/a', params), {
      wrapper: panel({ projectId: 'p-a' })
    })
    await flush()
    renderHook(() => useGitDiffSnapshot('/projects/b', params), {
      wrapper: panel({ projectId: 'p-b' })
    })
    await flush()
    first.unmount()
    await flush()

    expect(callsOf('watchStop')).toEqual([
      expect.objectContaining({
        worktreePath: '/projects/a',
        target: expect.objectContaining({ projectId: 'p-a' })
      })
    ])
  })
})
