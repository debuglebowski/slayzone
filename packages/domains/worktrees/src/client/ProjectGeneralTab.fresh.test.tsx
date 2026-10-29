// @vitest-environment jsdom
// The project General tab's git reads go through react-query's cache, whose app-wide
// default staleTime is 5s (transport provider). Its poll and the "sync done" re-read
// decide WHEN git is read, so a read must hit git: a cached answer would show the
// pre-sync ahead/behind (and, with the poll backed off on an unchanged hash, keep it).
// Same for a git change (fs watcher): the cached pre-edit status would land.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

let behind = 3
const aheadBehindReads: number[] = []
let unstaged = 0

// The domain's typed view (`./trpc`) re-types the transport client: serve
// it the transport mock below.
vi.mock('./trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => {
  // tRPC-shaped: queryOptions(input, opts) → a real query (key + fn + caller's opts).
  const q = (name: string, fn: (input: Record<string, string>) => Promise<unknown>) => ({
    queryOptions: (input: Record<string, string>, opts?: object) => ({
      queryKey: [name, input],
      queryFn: () => fn(input),
      ...opts
    })
  })
  const trpc = {
    worktrees: {
      init: { mutationOptions: () => ({}) },
      checkoutBranch: { mutationOptions: () => ({}) },
      createBranch: { mutationOptions: () => ({}) },
      isGitRepo: q('isGitRepo', async () => true),
      getCurrentBranch: q('getCurrentBranch', async () => 'main'),
      getStatusSummary: q('getStatusSummary', async () => ({
        staged: 0,
        unstaged,
        untracked: 0
      })),
      getRemoteUrl: q('getRemoteUrl', async () => 'https://example.com/r.git'),
      getAheadBehindUpstream: q('getAheadBehindUpstream', async () => {
        aheadBehindReads.push(behind)
        return { ahead: 0, behind }
      }),
      // The fs-watcher broadcasts: the test delivers them via `notifyDiffChanged`.
      onDiffChanged: { subscriptionOptions: () => ({}) },
      onDiffWatchFailed: { subscriptionOptions: () => ({}) }
    },
    settings: { get: q('settings.get', async () => null), set: { mutationOptions: () => ({}) } }
  }
  const trpcClient = {}
  return { useTRPC: () => trpc, useTRPCClient: () => trpcClient, useSubscription: () => undefined }
})
vi.mock('./BranchesTab', () => ({
  useBranchGraph: () => ({ refresh: async () => {} }),
  BranchGraphToolbar: () => null,
  BranchGraphCard: () => null
}))
// Shows what the tab passes down, and the sync button whose "done" re-reads git.
vi.mock('./RemoteSection', () => ({
  RemoteSection: ({
    upstreamAB,
    onSyncDone
  }: {
    upstreamAB: { behind: number } | null
    onSyncDone: () => void
  }) => (
    <>
      <span data-testid="behind">{upstreamAB ? upstreamAB.behind : '-'}</span>
      <button onClick={onSyncDone}>sync</button>
    </>
  )
}))

const { ProjectGeneralTab } = await import('./ProjectGeneralTab')
const { _setGitDiffStoreTransport, _resetStore, notifyDiffChanged } = await import(
  './git-diff-store'
)

beforeEach(() => {
  _setGitDiffStoreTransport({
    getWorkingDiff: () => new Promise(() => {}),
    watchStart: async () => {},
    watchStop: async () => {}
  })
})
afterEach(() => {
  cleanup()
  _resetStore()
  _setGitDiffStoreTransport(null)
  behind = 3
  unstaged = 0
  aheadBehindReads.length = 0
})

// Same default as the app's transport provider.
const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: false } } })

describe('ProjectGeneralTab git reads bypass the 5s query cache', () => {
  it('after a sync, shows the new ahead/behind at once (not the cached pre-sync one)', async () => {
    const client = newClient()
    render(
      <QueryClientProvider client={client}>
        <ProjectGeneralTab projectId="p1" projectPath="/repo" visible onSwitchToDiff={() => {}} />
      </QueryClientProvider>
    )
    await act(async () => {})
    expect(await screen.findByTestId('behind')).toHaveProperty('textContent', '3')

    // The sync pulled: upstream is now 0 behind. Well inside the 5s cache window.
    behind = 0
    fireEvent.click(screen.getByText('sync'))
    await act(async () => {})

    expect(aheadBehindReads.at(-1)).toBe(0)
    expect(screen.getByTestId('behind').textContent).toBe('0')
  })

  it('after a file edit, shows the new status at once (not the cached pre-edit one)', async () => {
    render(
      <QueryClientProvider client={newClient()}>
        <ProjectGeneralTab projectId="p1" projectPath="/repo" visible onSwitchToDiff={() => {}} />
      </QueryClientProvider>
    )
    expect(await screen.findByText('No changes')).not.toBeNull()

    // A file was edited: the watcher reports it well inside the 5s cache window.
    unstaged = 2
    await act(async () => notifyDiffChanged('/repo', false))
    await act(async () => {})

    expect(screen.queryByText('2 modified')).not.toBeNull()
  })
})
