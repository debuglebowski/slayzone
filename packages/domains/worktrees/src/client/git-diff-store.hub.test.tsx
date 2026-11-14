// @vitest-environment jsdom
// The shared git-diff store serves every git panel in the window, and with several
// hubs signed in those panels live in different `HubScope`s — each with its own tRPC
// client and QueryClient. The store used to wire ONE transport, from the first panel
// to mount, so a remote hub task's diff went out through the local hub's client and
// came back "task <id> is not on this hub" (2026-11-13, Diff tab of a remote task).
// Each panel's reads, watches and change events must stay on its own hub.
import type React from 'react'
import { createContext, useContext } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WorkspaceTargetProvider } from '@slayzone/file-editor/client/workspace-target'

const HubCtx = createContext<string | null>(null)
const seen: Array<[hub: string, proc: string, input: unknown]> = []
const subscribers: Array<{ hub: string; name: string; onData: (d: unknown) => void }> = []

const snapshot = {
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
const proc = (hub: string, name: string) => ({
  queryOptions: (input: unknown, opts?: object) => ({
    ...opts,
    queryKey: [name, input],
    queryFn: async () => {
      seen.push([hub, name, input])
      return snapshot
    }
  }),
  subscriptionOptions: (_input: unknown, opts: { onData: (d: unknown) => void }) => ({
    hub,
    name,
    onData: opts.onData
  }),
  mutate: async (input: unknown) => {
    seen.push([hub, name, input])
  }
})
const roots = new Map<string, unknown>()
const rootOf = (hub: string) => {
  let root = roots.get(hub)
  if (!root) {
    root = { worktrees: new Proxy({}, { get: (_t, name: string) => proc(hub, name) }) }
    roots.set(hub, root)
  }
  return root
}
const useRoot = () => rootOf(useContext(HubCtx) ?? 'default')

vi.mock('@slayzone/transport/client', async () => {
  const { useEffect } = await import('react')
  return {
    typedTrpc: () => ({ useTRPC: () => useRoot(), useTRPCClient: () => useRoot() }),
    useTRPC: () => useRoot(),
    useTRPCClient: () => useRoot(),
    useHubId: () => useContext(HubCtx),
    useSubscription: (opts: { hub: string; name: string; onData: (d: unknown) => void }) => {
      useEffect(() => {
        const sub = { hub: opts.hub, name: opts.name, onData: opts.onData }
        subscribers.push(sub)
        return () => {
          subscribers.splice(subscribers.indexOf(sub), 1)
        }
      })
    }
  }
})

const { useGitDiffSnapshot, _resetStore, _setGitDiffStoreTransport } = await import(
  './git-diff-store'
)

const queryClients = new Map<string, QueryClient>()
const panel =
  (hub: string, target: { taskId?: string; projectId?: string }) =>
  ({ children }: { children: React.ReactNode }) => {
    let qc = queryClients.get(hub)
    if (!qc) {
      qc = new QueryClient()
      queryClients.set(hub, qc)
    }
    return (
      <HubCtx.Provider value={hub}>
        <QueryClientProvider client={qc}>
          <WorkspaceTargetProvider target={target}>{children}</WorkspaceTargetProvider>
        </QueryClientProvider>
      </HubCtx.Provider>
    )
  }

const params = { ignoreWhitespace: false, pollIntervalMs: 60_000, visible: true }

beforeEach(() => {
  _resetStore()
  _setGitDiffStoreTransport(null)
})
afterEach(() => {
  cleanup()
  _resetStore()
  _setGitDiffStoreTransport(null)
  for (const qc of queryClients.values()) qc.clear()
  queryClients.clear()
  seen.length = 0
})

const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)))
const callsOf = (name: string) =>
  seen.filter(([, n]) => n === name).map(([hub, , input]) => ({ hub, input }))

describe('the git-diff store: each panel on its own hub', () => {
  it("a remote hub task's diff and watch go to the remote hub, not the first panel's", async () => {
    renderHook(() => useGitDiffSnapshot('/local/repo', params), {
      wrapper: panel('local', { taskId: 't-local' })
    })
    await flush()
    renderHook(() => useGitDiffSnapshot('/remote/repo', params), {
      wrapper: panel('remote', { taskId: 't-remote' })
    })
    await flush()

    expect(callsOf('getWorkingDiff')).toEqual([
      { hub: 'local', input: expect.objectContaining({ path: '/local/repo' }) },
      { hub: 'remote', input: expect.objectContaining({ path: '/remote/repo' }) }
    ])
    expect(callsOf('watchStart')).toEqual([
      { hub: 'local', input: expect.objectContaining({ worktreePath: '/local/repo' }) },
      { hub: 'remote', input: expect.objectContaining({ worktreePath: '/remote/repo' }) }
    ])
  })

  it('the last one out stops the watch on the hub that started it', async () => {
    renderHook(() => useGitDiffSnapshot('/local/repo', params), {
      wrapper: panel('local', { taskId: 't-local' })
    })
    await flush()
    const remote = renderHook(() => useGitDiffSnapshot('/remote/repo', params), {
      wrapper: panel('remote', { taskId: 't-remote' })
    })
    await flush()
    remote.unmount()
    await flush()

    expect(callsOf('watchStop')).toEqual([
      { hub: 'remote', input: expect.objectContaining({ worktreePath: '/remote/repo' }) }
    ])
  })

  it("a hub's change event refreshes only that hub's panels, even on the same path", async () => {
    renderHook(() => useGitDiffSnapshot('/repo', params), {
      wrapper: panel('local', { taskId: 't-local' })
    })
    renderHook(() => useGitDiffSnapshot('/repo', params), {
      wrapper: panel('remote', { taskId: 't-remote' })
    })
    await flush()
    seen.length = 0

    const remoteDiffChanged = subscribers.find(
      (s) => s.hub === 'remote' && s.name === 'onDiffChanged'
    )
    await act(async () => {
      remoteDiffChanged?.onData({ worktreePath: '/repo', refsChanged: false })
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(callsOf('getWorkingDiff').map((c) => c.hub)).toEqual(['remote'])
  })
})
