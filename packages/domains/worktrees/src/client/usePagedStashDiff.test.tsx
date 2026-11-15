// @vitest-environment jsdom
// The stash preview, bounded (FU1 S5): the stash's patch comes page by page
// (`worktrees.readGitText`); a stash larger than one page shows its first page and
// how much is left, and loads the rest on request. An older computer answers the
// whole patch as one page — the same path.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

const query = vi.fn()
// One client, as the app's (a new object per render would re-run every read).
const client = { worktrees: { readGitText: { query: (i: unknown) => query(i) } } }
vi.mock('./trpc', () => ({ useTRPCClient: () => client }))
const { usePagedStashDiff } = await import('./usePagedStashDiff')

const file = (p: string) =>
  `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-a\n+b\n`

afterEach(() => {
  cleanup()
  query.mockReset()
})

describe('usePagedStashDiff', () => {
  it('a small stash: one page, every file, no rest', async () => {
    query.mockResolvedValue({ text: file('a') + file('b'), cursor: null, totalBytes: 99 })
    const { result } = renderHook(() => usePagedStashDiff('/r', 0))
    await waitFor(() => expect(result.current.files.map((f) => f.path)).toEqual(['a', 'b']))
    expect(result.current.rest).toBeNull()
    expect(query).toHaveBeenCalledWith({
      repoPath: '/r',
      kind: 'stashDiff',
      index: 0,
      cursor: null
    })
  })

  it('a large stash: first page + its remaining size; loadRest brings every page', async () => {
    const whole = file('a') + file('b') + file('c')
    const pages = [file('a'), file('b'), file('c')]
    query.mockImplementation(async (i: { cursor: string | null }) => {
      const n = i.cursor === null ? 0 : Number(i.cursor)
      return {
        text: pages[n],
        cursor: n + 1 < pages.length ? String(n + 1) : null,
        totalBytes: whole.length
      }
    })
    const { result } = renderHook(() => usePagedStashDiff('/r', 3))
    await waitFor(() => expect(result.current.files.map((f) => f.path)).toEqual(['a']))
    expect(result.current.rest?.remainingBytes).toBe(whole.length - pages[0].length)
    await act(() => result.current.loadRest())
    expect(result.current.files.map((f) => f.path)).toEqual(['a', 'b', 'c'])
    expect(result.current.rest).toBeNull()
  })

  it('another stash starts over; none selected reads nothing', async () => {
    query.mockImplementation(async (i: { index: number }) => ({
      text: file(`s${i.index}`),
      cursor: null,
      totalBytes: 1
    }))
    const { result, rerender } = renderHook(({ index }) => usePagedStashDiff('/r', index), {
      initialProps: { index: 1 as number | null }
    })
    await waitFor(() => expect(result.current.files[0]?.path).toBe('s1'))
    rerender({ index: 2 })
    await waitFor(() => expect(result.current.files[0]?.path).toBe('s2'))
    query.mockClear()
    rerender({ index: null })
    expect(result.current.files).toEqual([])
    expect(query).not.toHaveBeenCalled()
  })
})
