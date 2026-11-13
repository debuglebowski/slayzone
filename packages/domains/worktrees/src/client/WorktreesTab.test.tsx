// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { DetectedWorktree } from '../shared/types'

let worktrees: DetectedWorktree[] = []
const dirtyReads: string[] = []
const worktree = (path: string, isMain = false): DetectedWorktree => ({
  path,
  branch: path,
  isMain
})

vi.mock('./trpc', () => {
  const trpc = {
    worktrees: {
      removeWorktree: { mutationOptions: () => ({}) },
      detectWorktrees: { queryOptions: () => ({ queryFn: async () => worktrees }) },
      isDirty: {
        queryOptions: ({ path }: { path: string }) => ({
          queryFn: async () => {
            dirtyReads.push(path)
            return path === '/b'
          }
        })
      }
    }
  }
  return { useTRPC: () => trpc }
})
vi.mock('@tanstack/react-query', () => {
  const client = { fetchQuery: (opts: { queryFn: () => unknown }) => opts.queryFn() }
  return { useMutation: () => ({}), useQueryClient: () => client }
})
vi.mock('./git-panel-context', () => {
  const context = { projectPath: '/repo', tasks: [], worktreeOf: () => undefined }
  return { useGitPanelContext: () => context }
})
vi.mock('./CreateWorktreeDialog', () => ({ CreateWorktreeDialog: () => null }))
vi.mock('./GroupedTaskList', () => ({ GroupedTaskList: () => null }))
vi.mock('./WorktreeCard', () => ({
  WorktreeCard: ({ node }: { node: { path: string; isDirty: boolean } }) => (
    <div data-testid={node.path}>{node.isDirty ? 'dirty' : 'clean'}</div>
  )
}))

const { WorktreesTab } = await import('./WorktreesTab')
const flush = () => act(async () => {})
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

beforeEach(() => {
  vi.useFakeTimers()
  // Even an unlucky random source must not starve a background worktree.
  vi.spyOn(Math, 'random').mockReturnValue(0)
  worktrees = [worktree('/repo', true), worktree('/a'), worktree('/b'), worktree('/c')]
  dirtyReads.length = 0
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('WorktreesTab dirty polling', () => {
  it('refreshes every background worktree within one sweep, with one background read per tick', async () => {
    render(<WorktreesTab visible />)
    await flush()
    await advance(10_000)
    await advance(10_000)

    expect(dirtyReads.filter((path) => path === '/repo')).toHaveLength(3)
    expect(dirtyReads.filter((path) => path !== '/repo').sort()).toEqual(['/a', '/b', '/c'])
    expect(screen.getByTestId('/b').textContent).toBe('dirty')
  })

  it('keeps polling remaining and newly discovered worktrees after a checkout disappears', async () => {
    render(<WorktreesTab visible />)
    await flush()
    // The last background checkout read is removed before the next tick.
    worktrees = [worktree('/repo', true), worktree('/b'), worktree('/c'), worktree('/d')]
    await advance(5_000)
    dirtyReads.length = 0
    await advance(5_000)
    await advance(10_000)
    await advance(10_000)

    expect(dirtyReads.filter((path) => path !== '/repo').sort()).toEqual(['/b', '/c', '/d'])
  })
})
