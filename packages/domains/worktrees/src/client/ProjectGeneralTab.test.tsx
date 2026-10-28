// @vitest-environment jsdom
// The project git panel's General tab polls the project's git state (repo check,
// branch, status, remote, ahead/behind) while visible, backing off while nothing
// changes. "Checking..." shows until the first read lands. A project path change (the
// git panel's repo picker) reads the new path at once, and a read still in flight for
// the old path never lands: neither its data nor the end of "Checking...".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// The branch read is the one the tests hold: it carries what the tab shows (the
// branch name). Everything else answers at once.
let branchCalls: Array<{ path: string; d: Deferred<string> }> = []
const repoChecks: string[] = []

// The domain's typed view (`./trpc`) re-types the transport client: serve
// it the transport mock below.
vi.mock('./trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => {
  const q = (fn: (input: { path?: string; repoPath?: string }) => Promise<unknown>) => ({
    queryOptions: (input: { path?: string; repoPath?: string }) => ({ queryFn: () => fn(input) })
  })
  // Stable: the tab keys callbacks on `trpc`.
  const trpc = {
    worktrees: {
      init: { mutationOptions: () => ({}) },
      checkoutBranch: { mutationOptions: () => ({}) },
      createBranch: { mutationOptions: () => ({}) },
      isGitRepo: q(async (input) => {
        repoChecks.push(input.path!)
        return true
      }),
      getCurrentBranch: q((input) => {
        const d = deferred<string>()
        branchCalls.push({ path: input.path!, d })
        return d.promise
      }),
      getStatusSummary: q(async () => ({ staged: 0, unstaged: 0, untracked: 0 })),
      getRemoteUrl: q(async () => 'https://example.com/r.git'),
      getAheadBehindUpstream: q(async () => ({ ahead: 0, behind: 0 }))
    },
    settings: { get: q(async () => null), set: { mutationOptions: () => ({}) } }
  }
  return { useTRPC: () => trpc }
})
vi.mock('@tanstack/react-query', () => {
  const mutation = { mutate: () => {}, mutateAsync: async () => undefined }
  const queryClient = { fetchQuery: (opts: { queryFn: () => unknown }) => opts.queryFn() }
  return { useMutation: () => mutation, useQueryClient: () => queryClient }
})
// The commit graph has its own tests (useBranchGraph.test.tsx).
const graphState = { refresh: vi.fn(async () => {}) }
vi.mock('./BranchesTab', () => ({
  useBranchGraph: () => graphState,
  BranchGraphToolbar: () => null,
  BranchGraphCard: () => null
}))
// The remote section's sync button: what "sync done" triggers is pinned here.
vi.mock('./RemoteSection', () => ({
  RemoteSection: ({ onSyncDone }: { onSyncDone: () => void }) => (
    <button onClick={onSyncDone}>sync</button>
  )
}))

const { ProjectGeneralTab } = await import('./ProjectGeneralTab')

function Tab({ path = '/repo', visible = true }: { path?: string | null; visible?: boolean }) {
  return (
    <ProjectGeneralTab
      projectId="p1"
      projectPath={path}
      visible={visible}
      onSwitchToDiff={() => {}}
    />
  )
}

const flush = () => act(async () => {})
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
const callsFor = (path: string) => branchCalls.filter((c) => c.path === path)
const land = (i: number, branch: string) =>
  act(async () => {
    branchCalls[i].d.resolve(branch)
  })
/** Resolve every branch read made so far for `path` (an already-settled one ignores it). */
const landAll = (path: string, branch: string) =>
  act(async () => {
    for (const c of callsFor(path)) c.d.resolve(branch)
  })
const checking = () => screen.queryByText('Checking...') !== null
const shownBranch = (name: string) => screen.queryByText(name) !== null

beforeEach(() => {
  branchCalls = []
  repoChecks.length = 0
  graphState.refresh.mockClear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ProjectGeneralTab — git poll', () => {
  it('shows Checking... until the first read lands', async () => {
    render(<Tab />)
    await flush()
    expect(checking()).toBe(true)
    expect(branchCalls.map((c) => c.path)).toEqual(['/repo'])
    await land(0, 'main')
    expect(checking()).toBe(false)
    expect(shownBranch('main')).toBe(true)
  })

  it('polls every 5s while visible, backing off while nothing changes', async () => {
    vi.useFakeTimers()
    render(<Tab />)
    await flush()
    await land(0, 'main')
    // Delay after each read: 5s on a change (or the first read), doubling per
    // unchanged read, capped at 60s.
    const steps: Array<[number, string]> = [
      [5_000, 'main'],
      [10_000, 'main'],
      [20_000, 'main'],
      [40_000, 'main'],
      [60_000, 'main'],
      [60_000, 'dev'],
      [5_000, 'dev']
    ]
    for (const [delay, next] of steps) {
      const before = branchCalls.length
      await advance(delay - 1)
      expect(branchCalls).toHaveLength(before)
      await advance(1)
      expect(branchCalls).toHaveLength(before + 1)
      await land(before, next)
    }
    expect(branchCalls.every((c) => c.path === '/repo')).toBe(true)
    expect(shownBranch('dev')).toBe(true)
  })

  it('stops polling while not visible; resumes at once', async () => {
    vi.useFakeTimers()
    const view = render(<Tab />)
    await flush()
    await land(0, 'main')
    view.rerender(<Tab visible={false} />)
    await advance(120_000)
    expect(branchCalls).toHaveLength(1)
    view.rerender(<Tab />)
    await flush()
    expect(branchCalls).toHaveLength(2)
  })

  it('no project path: no read', async () => {
    vi.useFakeTimers()
    render(<Tab path={null} />)
    await advance(60_000)
    expect(repoChecks).toHaveLength(0)
    expect(screen.queryByText('Set a project path to use Git features')).not.toBeNull()
  })

  it('a finished sync re-reads git and the graph at once', async () => {
    vi.useFakeTimers()
    render(<Tab />)
    await flush()
    await land(0, 'main')
    fireEvent.click(screen.getByText('sync'))
    await flush()
    expect(branchCalls).toHaveLength(2)
    expect(graphState.refresh).toHaveBeenCalledTimes(1)
    await land(1, 'dev')
    expect(shownBranch('dev')).toBe(true)
  })

  it("a project path change keeps the old project's data on screen until the new one lands", async () => {
    vi.useFakeTimers()
    const view = render(<Tab />)
    await flush()
    await land(0, 'main')
    view.rerender(<Tab path="/other" />)
    expect(checking()).toBe(false)
    expect(shownBranch('main')).toBe(true)
    // Covers the poll's next tick too (when the new path is read is pinned below).
    await advance(5_000)
    await landAll('/other', 'other-main')
    expect(shownBranch('other-main')).toBe(true)
  })

  describe('project path change while a read for the old path is in flight', () => {
    it("the old path's late first read does not land, nor end Checking...", async () => {
      vi.useFakeTimers()
      const view = render(<Tab />)
      await flush()
      expect(callsFor('/repo')).toHaveLength(1)
      view.rerender(<Tab path="/other" />)
      await land(0, 'main')
      expect(checking()).toBe(true)
      expect(shownBranch('main')).toBe(false)

      await advance(5_000)
      await landAll('/other', 'other-main')
      expect(checking()).toBe(false)
      expect(shownBranch('other-main')).toBe(true)
    })

    it("the old path's late read does not replace the new path's data", async () => {
      vi.useFakeTimers()
      const view = render(<Tab />)
      await flush()
      await land(0, 'main')
      await advance(5_000) // poll tick: a second /repo read, held in flight
      expect(callsFor('/repo')).toHaveLength(2)

      view.rerender(<Tab path="/other" />)
      // A finished sync reads the new path now, whatever the poll does.
      fireEvent.click(screen.getByText('sync'))
      await flush()
      await landAll('/other', 'other-main')
      expect(shownBranch('other-main')).toBe(true)

      await land(1, 'repo-dev')
      expect(shownBranch('other-main')).toBe(true)
      expect(shownBranch('repo-dev')).toBe(false)
    })
  })

  describe('a project path change reads the new path at once', () => {
    it('even while the poll is backed off; the new path then polls from the base delay', async () => {
      vi.useFakeTimers()
      const view = render(<Tab />)
      await flush()
      await land(0, 'main')
      for (const [i, delay] of [5_000, 10_000, 20_000, 40_000].entries()) {
        await advance(delay)
        await land(i + 1, 'main')
      }
      expect(callsFor('/repo')).toHaveLength(5)
      await advance(1_000)

      view.rerender(<Tab path="/other" />)
      await flush()
      expect(callsFor('/other')).toHaveLength(1)
      await landAll('/other', 'other-main')
      expect(shownBranch('other-main')).toBe(true)

      await advance(4_999)
      expect(callsFor('/other')).toHaveLength(1)
      await advance(1)
      expect(callsFor('/other')).toHaveLength(2)
      expect(callsFor('/repo')).toHaveLength(5)
    })

    it("even while the old path's read is still in flight; the old path is never read again", async () => {
      vi.useFakeTimers()
      const view = render(<Tab />)
      await flush()
      await land(0, 'main')
      await advance(5_000) // poll tick: a second /repo read, held in flight

      view.rerender(<Tab path="/other" />)
      await flush()
      expect(callsFor('/other')).toHaveLength(1)
      await landAll('/other', 'other-main')

      // The abandoned /repo read settles late: it starts no /repo polling.
      await land(1, 'main')
      await advance(5_000)
      expect(callsFor('/other')).toHaveLength(2)
      await landAll('/other', 'other-main')
      await advance(120_000)
      expect(callsFor('/repo')).toHaveLength(2)
      expect(shownBranch('other-main')).toBe(true)
    })
  })
})
