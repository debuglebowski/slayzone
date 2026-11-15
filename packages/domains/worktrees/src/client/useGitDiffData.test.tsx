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
// The panel's scoped vanilla client: the per-file reads (untracked previews, the
// files a paged snapshot deferred, a large file's pages).
const untrackedQuery = vi.fn()
const filesPageQuery = vi.fn()
const textQuery = vi.fn()
vi.mock('./trpc', () => ({
  useTRPCClient: () => ({
    worktrees: {
      getUntrackedFileDiffs: { query: untrackedQuery },
      getFileDiffsPage: { query: filesPageQuery },
      readGitText: { query: textQuery }
    }
  })
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
  untrackedQuery.mockReset()
  filesPageQuery.mockReset()
  textQuery.mockReset()
})

const OPTS = {
  visible: true,
  ignoreWhitespace: false,
  contextLines: 'all' as const,
  pollIntervalMs: 5000,
  fromSha: undefined,
  toSha: undefined,
  onSnapshotChange: () => {}
}
const patchOf = (f: string) =>
  `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1 @@\n+x\n`

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

  it('reads the new untracked files in ONE batched (paged) call, not one per file', async () => {
    untrackedQuery.mockImplementation(async (i: { filePaths: string[] }) => ({
      $paged: true,
      diffs: Object.fromEntries(i.filePaths.map((f) => [f, patchOf(f)])),
      deferred: [],
      large: []
    }))
    snapshotState.snapshot = { ...snap([]), untrackedFiles: ['u1.txt', 'u2.txt', 'u3.txt'] }
    const { result } = renderHook(() => useGitDiffData('/repo', OPTS))
    await vi.waitFor(() =>
      expect(
        result.current.getDiffForEntry({ path: 'u2.txt', status: '?', source: 'unstaged' })
      ).toBeDefined()
    )
    expect(untrackedQuery).toHaveBeenCalledTimes(1)
    expect(untrackedQuery.mock.calls[0][0]).toEqual({
      repoPath: '/repo',
      filePaths: ['u1.txt', 'u2.txt', 'u3.txt'],
      paged: true
    })
  })

  it('an older computer’s whole untracked record still previews', async () => {
    untrackedQuery.mockImplementation(async (i: { filePaths: string[] }) =>
      Object.fromEntries(i.filePaths.map((f) => [f, patchOf(f)]))
    )
    snapshotState.snapshot = { ...snap([]), untrackedFiles: ['u1.txt'] }
    const { result } = renderHook(() => useGitDiffData('/repo', OPTS))
    await vi.waitFor(() =>
      expect(
        result.current.getDiffForEntry({ path: 'u1.txt', status: '?', source: 'unstaged' })
      ).toBeDefined()
    )
  })

  it('files a paged snapshot deferred load in; until then they are pending', async () => {
    let release: () => void = () => {}
    filesPageQuery.mockImplementation(
      (i: { filePaths: string[]; kind: string; opts: unknown }) =>
        new Promise((r) => {
          release = () =>
            r({
              diffs: Object.fromEntries(i.filePaths.map((f) => [f, patchOf(f)])),
              deferred: [],
              large: []
            })
        })
    )
    snapshotState.snapshot = {
      ...snap(['a.ts', 'b.ts']),
      unstagedPatch: patchOf('a.ts'),
      deferred: { unstaged: ['b.ts'], staged: [], renamedFrom: {}, fingerprint: 'f' }
    }
    const { result } = renderHook(() => useGitDiffData('/repo', OPTS))
    const b = { path: 'b.ts', status: 'M' as const, source: 'unstaged' as const }
    await vi.waitFor(() => expect(filesPageQuery).toHaveBeenCalledTimes(1))
    expect(filesPageQuery.mock.calls[0][0]).toEqual({
      repoPath: '/repo',
      kind: 'unstaged',
      filePaths: ['b.ts'],
      opts: { contextLines: 'all', ignoreWhitespace: false }
    })
    expect(result.current.getDiffForEntry(b)).toBeUndefined()
    expect(result.current.isDiffPending(b)).toBe(true)
    release()
    await vi.waitFor(() => expect(result.current.getDiffForEntry(b)).toBeDefined())
    expect(result.current.isDiffPending(b)).toBe(false)
  })

  it('a large deferred file shows its first page; loadDiffRest brings the rest', async () => {
    const head = 'diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -1,2 +1,2 @@\n-a\n'
    const tail = '+b\n'
    filesPageQuery.mockResolvedValue({ diffs: {}, deferred: [], large: ['big.ts'] })
    textQuery.mockImplementation(async (i: { cursor: string | null }) =>
      i.cursor === null
        ? { text: head, cursor: 'c1', totalBytes: head.length + tail.length }
        : { text: tail, cursor: null, totalBytes: head.length + tail.length }
    )
    snapshotState.snapshot = {
      ...snap(['big.ts']),
      deferred: { unstaged: ['big.ts'], staged: [], renamedFrom: {}, fingerprint: 'f' }
    }
    const { result } = renderHook(() => useGitDiffData('/repo', OPTS))
    const big = { path: 'big.ts', status: 'M' as const, source: 'unstaged' as const }
    await vi.waitFor(() => expect(result.current.getDiffRest(big)).not.toBeNull())
    expect(result.current.getDiffRest(big)?.remainingBytes).toBe(tail.length)
    expect(textQuery.mock.calls[0][0]).toMatchObject({
      kind: 'fileDiff',
      filePath: 'big.ts',
      staged: false,
      cursor: null
    })
    await result.current.loadDiffRest(big)
    await vi.waitFor(() => expect(result.current.getDiffRest(big)).toBeNull())
    expect(result.current.getDiffForEntry(big)?.additions).toBe(1)
  })
})
