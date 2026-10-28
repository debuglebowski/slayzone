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
// The domain's typed view (`./trpc`) re-types the transport client: serve
// it the transport mock below.
vi.mock('./trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    worktrees: {
      getUntrackedFileDiffs: {
        queryOptions: (input: unknown) => ({ queryKey: ['getUntrackedFileDiffs', input] })
      }
    }
  })
}))
const fetchQuery = vi.fn()
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ fetchQuery })
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

afterEach(() => {
  cleanup()
  fetchQuery.mockReset()
})

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

  it('reads the new untracked files in ONE batched call, not one per file', async () => {
    const patch = (f: string) =>
      `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1 @@\n+x\n`
    fetchQuery.mockImplementation(async (o: { queryKey: [string, { filePaths: string[] }] }) =>
      Object.fromEntries(o.queryKey[1].filePaths.map((f) => [f, patch(f)]))
    )
    snapshotState.snapshot = { ...snap([]), untrackedFiles: ['u1.txt', 'u2.txt', 'u3.txt'] }
    const { result } = renderHook(() =>
      useGitDiffData('/repo', {
        visible: true,
        ignoreWhitespace: false,
        contextLines: 'all',
        pollIntervalMs: 5000,
        fromSha: undefined,
        toSha: undefined,
        onSnapshotChange: () => {}
      })
    )
    await vi.waitFor(() =>
      expect(
        result.current.getDiffForEntry({ path: 'u2.txt', status: '?', source: 'unstaged' })
      ).toBeDefined()
    )
    expect(fetchQuery).toHaveBeenCalledTimes(1)
    expect(fetchQuery.mock.calls[0][0].queryKey[1]).toEqual({
      repoPath: '/repo',
      filePaths: ['u1.txt', 'u2.txt', 'u3.txt']
    })
  })
})
