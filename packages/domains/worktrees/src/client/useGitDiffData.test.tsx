// @vitest-environment jsdom
// Pins useGitDiffData's refreshRef (always the snapshot store's current refresh)
// and its snapshot-change notification.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'

const snapshotState: { snapshot: unknown; refresh: () => void } = {
  snapshot: null,
  refresh: () => {}
}
vi.mock('./git-diff-store', () => ({
  useGitDiffSnapshot: () => ({
    snapshot: snapshotState.snapshot,
    loading: false,
    error: null,
    refresh: snapshotState.refresh
  })
}))
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({ worktrees: { getUntrackedFileDiff: { queryOptions: () => ({}) } } })
}))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ fetchQuery: vi.fn().mockResolvedValue('') })
}))

const { useGitDiffData } = await import('./useGitDiffData')

const snap = (files: string[]) => ({
  files,
  unstagedFiles: files,
  stagedFiles: [],
  untrackedFiles: [],
  unstagedPatch: '',
  stagedPatch: ''
})

afterEach(cleanup)

describe('useGitDiffData', () => {
  it('refreshRef always holds the current refresh', () => {
    const r1 = vi.fn()
    snapshotState.refresh = r1
    const onSnapshotChange = vi.fn()
    const opts = {
      visible: true,
      ignoreWhitespace: false,
      contextLines: 'all' as const,
      pollIntervalMs: 5000,
      fromSha: undefined,
      toSha: undefined,
      onSnapshotChange
    }
    const { result, rerender } = renderHook(() => useGitDiffData('/repo', opts))
    expect(result.current.refreshRef.current).toBe(r1)
    rerender()
    expect(result.current.refreshRef.current).toBe(r1)

    const r2 = vi.fn()
    snapshotState.refresh = r2
    rerender()
    expect(result.current.refreshRef.current).toBe(r2)
    result.current.refreshRef.current()
    expect(r2).toHaveBeenCalledTimes(1)
  })

  it('notifies on each new snapshot, not on re-renders', () => {
    snapshotState.snapshot = null
    const onSnapshotChange = vi.fn()
    const opts = {
      visible: true,
      ignoreWhitespace: false,
      contextLines: 'all' as const,
      pollIntervalMs: 5000,
      fromSha: undefined,
      toSha: undefined,
      onSnapshotChange
    }
    const { result, rerender } = renderHook(() => useGitDiffData('/repo', opts))
    expect(onSnapshotChange).not.toHaveBeenCalled()
    snapshotState.snapshot = snap(['a.ts'])
    rerender()
    rerender()
    expect(onSnapshotChange).toHaveBeenCalledTimes(1)
    expect(result.current.unstagedEntries.map((e) => e.path)).toEqual(['a.ts'])
    expect(result.current.hasAnyChanges).toBe(true)
  })
})
