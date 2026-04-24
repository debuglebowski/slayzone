/**
 * @vitest-environment jsdom
 *
 * Tests for git-diff-store.ts — shared, refcounted snapshot poll store.
 *
 * Exercises the pure module surface (subscribeEntry via useGitDiffSnapshot),
 * not the React render output. `window.api.git.*` is stubbed with a
 * controllable mock. Fake timers drive poll intervals.
 *
 * Run: pnpm --filter @slayzone/worktrees exec vitest run src/client/git-diff-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import {
  useGitDiffSnapshot,
  _storeStats,
  _storeEntryKeys,
  _resetStore,
  _pathWatcherStats,
} from './git-diff-store'
import type { GitDiffSnapshot } from '../shared/types'

// ── Stub window.api.git ────────────────────────────────────────────────
//
// `getWorkingDiff` returns the NEXT queued snapshot (or the last one forever
// if the queue is drained). Each test pushes specific snapshots. If no
// snapshot is queued, returns an EMPTY_SNAPSHOT sentinel.

function makeSnapshot(patch: string): GitDiffSnapshot {
  return {
    targetPath: '/tmp/repo',
    files: [],
    stagedFiles: [],
    unstagedFiles: [],
    untrackedFiles: [],
    unstagedPatch: patch,
    stagedPatch: '',
    generatedAt: new Date().toISOString(),
    isGitRepo: true,
  }
}

const gitStub = {
  getWorkingDiff: vi.fn<() => Promise<GitDiffSnapshot>>(),
  watchStart: vi.fn<(p: string) => Promise<void>>(),
  watchStop: vi.fn<(p: string) => Promise<void>>(),
  diffChangedListeners: new Set<(p: string) => void>(),
  onDiffChanged(cb: (p: string) => void): () => void {
    gitStub.diffChangedListeners.add(cb)
    return () => gitStub.diffChangedListeners.delete(cb)
  },
  _emitDiffChanged(path: string): void {
    for (const cb of gitStub.diffChangedListeners) cb(path)
  },
}

beforeEach(() => {
  vi.useFakeTimers()
  _resetStore()
  gitStub.getWorkingDiff.mockReset()
  gitStub.watchStart.mockReset()
  gitStub.watchStop.mockReset()
  gitStub.diffChangedListeners.clear()
  // Default: resolve to a fresh empty snapshot unless test overrides.
  gitStub.getWorkingDiff.mockImplementation(async () => makeSnapshot(''))
  // Default: watchStart never resolves (keeps watcher inactive) so poll-only
  // semantics are observable. Tests that want watcher-active override.
  gitStub.watchStart.mockImplementation(() => new Promise(() => {}))
  gitStub.watchStop.mockResolvedValue(undefined)

  // Install the stub on window.api.
  ;(globalThis as unknown as { window: { api: { git: typeof gitStub } } }).window = {
    api: { git: gitStub },
  }
})

afterEach(() => {
  _resetStore()
  vi.useRealTimers()
})

// Convenience — subscribe via useGitDiffSnapshot.
function mount(
  targetPath: string | null,
  params: {
    ignoreWhitespace?: boolean
    fromSha?: string
    toSha?: string
    pollIntervalMs?: number
    visible?: boolean
  } = {}
) {
  return renderHook(() =>
    useGitDiffSnapshot(targetPath, {
      ignoreWhitespace: params.ignoreWhitespace ?? false,
      fromSha: params.fromSha,
      toSha: params.toSha,
      pollIntervalMs: params.pollIntervalMs ?? 5000,
      visible: params.visible ?? true,
    })
  )
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    // Let pending Promises settle; fake timers don't fire microtasks.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('git-diff-store refcount + sharing', () => {
  it('two subscribers with same params share one entry + one timer', async () => {
    const h1 = mount('/tmp/repo', { pollIntervalMs: 5000 })
    const h2 = mount('/tmp/repo', { pollIntervalMs: 5000 })
    await flushMicrotasks()

    const stats = _storeStats()
    expect(stats.entries).toBe(1)
    expect(stats.subscribers).toBe(2)
    expect(stats.timers).toBe(1)
    expect(_storeEntryKeys()).toHaveLength(1)

    h1.unmount()
    h2.unmount()
  })

  it('third subscriber with different params creates a new entry', async () => {
    mount('/tmp/repo', { ignoreWhitespace: false })
    mount('/tmp/repo', { ignoreWhitespace: false })
    mount('/tmp/repo', { ignoreWhitespace: true }) // different key
    await flushMicrotasks()

    const stats = _storeStats()
    expect(stats.entries).toBe(2)
    expect(stats.subscribers).toBe(3)
  })

  it('last unsubscribe evicts the entry and clears the timer', async () => {
    const h1 = mount('/tmp/repo')
    const h2 = mount('/tmp/repo')
    await flushMicrotasks()
    expect(_storeStats().entries).toBe(1)

    h1.unmount()
    expect(_storeStats().entries).toBe(1)
    expect(_storeStats().subscribers).toBe(1)

    h2.unmount()
    const stats = _storeStats()
    expect(stats.entries).toBe(0)
    expect(stats.subscribers).toBe(0)
    expect(stats.timers).toBe(0)
  })

  it('visible=false holds no subscription', async () => {
    mount('/tmp/repo', { visible: false })
    await flushMicrotasks()
    expect(_storeStats().entries).toBe(0)
  })

  it('targetPath=null holds no subscription', async () => {
    mount(null)
    await flushMicrotasks()
    expect(_storeStats().entries).toBe(0)
  })

  it('snapshotsEqual short-circuit: identical poll response keeps snapshot reference stable', async () => {
    const same = makeSnapshot('patch-A')
    gitStub.getWorkingDiff.mockResolvedValue(same)

    const h = mount('/tmp/repo', { pollIntervalMs: 1000 })
    await flushMicrotasks()
    const snap1 = h.result.current.snapshot
    expect(snap1).not.toBeNull()
    expect(snap1?.unstagedPatch).toBe('patch-A')

    // Advance timer to trigger a second poll that returns a structurally
    // equal (but different object) snapshot.
    gitStub.getWorkingDiff.mockResolvedValue(makeSnapshot('patch-A'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    const snap2 = h.result.current.snapshot
    // snapshotsEqual → prev reference retained.
    expect(snap2).toBe(snap1)

    h.unmount()
  })

  it('different poll response replaces the snapshot reference', async () => {
    gitStub.getWorkingDiff.mockResolvedValueOnce(makeSnapshot('patch-A'))
    gitStub.getWorkingDiff.mockResolvedValueOnce(makeSnapshot('patch-B'))

    const h = mount('/tmp/repo', { pollIntervalMs: 1000 })
    await flushMicrotasks()
    const snap1 = h.result.current.snapshot
    expect(snap1?.unstagedPatch).toBe('patch-A')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    const snap2 = h.result.current.snapshot
    expect(snap2).not.toBe(snap1)
    expect(snap2?.unstagedPatch).toBe('patch-B')

    h.unmount()
  })

  it('polls at the minimum interval across subscribers', async () => {
    gitStub.getWorkingDiff.mockResolvedValue(makeSnapshot(''))

    const hSlow = mount('/tmp/repo', { pollIntervalMs: 10_000 })
    await flushMicrotasks()
    // Initial fetch only.
    expect(gitStub.getWorkingDiff).toHaveBeenCalledTimes(1)

    // After 5s: slow interval not yet due.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(gitStub.getWorkingDiff).toHaveBeenCalledTimes(1)

    // Add a faster subscriber — min interval shrinks to 1s; next fire within 1s.
    const hFast = mount('/tmp/repo', { pollIntervalMs: 1_000 })
    await flushMicrotasks()
    // New subscriber does NOT trigger an extra initial fetch (entry already
    // exists), so count is still 1 at this moment.
    expect(gitStub.getWorkingDiff).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(gitStub.getWorkingDiff).toHaveBeenCalledTimes(2)

    hSlow.unmount()
    hFast.unmount()
  })

  it('error state propagates; next successful poll clears it', async () => {
    gitStub.getWorkingDiff.mockRejectedValueOnce(new Error('boom'))

    const h = mount('/tmp/repo', { pollIntervalMs: 1_000 })
    await flushMicrotasks()
    expect(h.result.current.error).toBe('boom')
    expect(h.result.current.snapshot).toBeNull()

    gitStub.getWorkingDiff.mockResolvedValueOnce(makeSnapshot('recovered'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(h.result.current.error).toBeNull()
    expect(h.result.current.snapshot?.unstagedPatch).toBe('recovered')

    h.unmount()
  })

  it('path watcher refcount: two entries on same path share one watcher', async () => {
    mount('/tmp/repo', { ignoreWhitespace: false })
    mount('/tmp/repo', { ignoreWhitespace: true })
    await flushMicrotasks()

    expect(_pathWatcherStats().paths).toBe(1)
    expect(gitStub.watchStart).toHaveBeenCalledTimes(1)
    expect(gitStub.watchStart).toHaveBeenCalledWith('/tmp/repo')
  })

  it('refresh() triggers an immediate re-fetch outside the poll cadence', async () => {
    gitStub.getWorkingDiff.mockResolvedValueOnce(makeSnapshot('v1'))
    gitStub.getWorkingDiff.mockResolvedValueOnce(makeSnapshot('v2'))

    const h = mount('/tmp/repo', { pollIntervalMs: 60_000 })
    await flushMicrotasks()
    expect(h.result.current.snapshot?.unstagedPatch).toBe('v1')

    await act(async () => {
      h.result.current.refresh()
    })
    await flushMicrotasks()
    expect(h.result.current.snapshot?.unstagedPatch).toBe('v2')
    expect(gitStub.getWorkingDiff).toHaveBeenCalledTimes(2)

    h.unmount()
  })
})
