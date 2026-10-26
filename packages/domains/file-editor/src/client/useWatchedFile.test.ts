// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { createTrpcTest } from '@slayzone/transport/testing'
import { useWatchedFile } from './useWatchedFile'

type FileWatchEvent = { type: 'changed' | 'deleted'; root: string; relPath: string }

// Every live fileEditor.watch subscription, served through the real tRPC
// client + provider so the test drives the hook's file-watcher path.
interface WatchController {
  /** push callbacks for currently-open subscriptions */
  active: Set<(event: FileWatchEvent) => void>
  /** true once at least one subscription was opened (i.e. enabled) */
  everEnabled: boolean
  emit: (root: string, rel: string, type?: FileWatchEvent['type']) => void
  reset: () => void
}

const watchController: WatchController = {
  active: new Set(),
  everEnabled: false,
  emit: (root, rel, type = 'changed') => {
    for (const push of watchController.active) push({ type, root, relPath: rel })
  },
  reset: () => {
    watchController.active.clear()
    watchController.everEnabled = false
  }
}

let wrapper: (props: { children: ReactNode }) => ReactNode

const ROOT = '/tmp/proj'
const REL = 'CLAUDE.md'

beforeEach(() => {
  watchController.reset()
  wrapper = createTrpcTest({
    subscriptions: {
      'fileEditor.watch': (_input, push) => {
        watchController.everEnabled = true
        watchController.active.add(push)
        return () => watchController.active.delete(push)
      }
    }
  }).wrapper
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  watchController.reset()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function flushPromises() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useWatchedFile', () => {
  it('loads initial content and is clean', async () => {
    const read = vi.fn(async () => 'hello')
    const save = vi.fn(async () => undefined)

    const { result } = renderHook(
      () => useWatchedFile({ projectPath: ROOT, relPath: REL, read, save }),
      { wrapper }
    )
    await flushPromises()

    expect(result.current.content).toBe('hello')
    expect(result.current.dirty).toBe(false)
    expect(result.current.diskChanged).toBe(false)
    expect(read).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
  })

  it('setContent flips dirty and debounce triggers save', async () => {
    const read = vi.fn(async () => 'old')
    const save = vi.fn(async () => undefined)

    const { result } = renderHook(
      () => useWatchedFile({ projectPath: ROOT, relPath: REL, read, save, debounceMs: 100 }),
      { wrapper }
    )
    await flushPromises()

    act(() => {
      result.current.setContent('new')
    })
    expect(result.current.dirty).toBe(true)
    expect(save).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    await flushPromises()

    expect(save).toHaveBeenCalledWith('new')
    expect(result.current.dirty).toBe(false)
  })

  it('onBlur flushes immediately without waiting for debounce', async () => {
    const read = vi.fn(async () => 'old')
    const save = vi.fn(async () => undefined)

    const { result } = renderHook(
      () => useWatchedFile({ projectPath: ROOT, relPath: REL, read, save, debounceMs: 500 }),
      { wrapper }
    )
    await flushPromises()

    act(() => {
      result.current.setContent('blurred')
    })
    await act(async () => {
      await result.current.onBlur()
    })

    expect(save).toHaveBeenCalledWith('blurred')
    expect(result.current.dirty).toBe(false)
  })

  it('external change when clean → silent reload', async () => {
    let diskContent = 'v1'
    const read = vi.fn(async () => diskContent)
    const save = vi.fn(async () => undefined)

    const { result } = renderHook(
      () => useWatchedFile({ projectPath: ROOT, relPath: REL, read, save }),
      { wrapper }
    )
    await flushPromises()
    expect(result.current.content).toBe('v1')

    diskContent = 'v2'
    act(() => {
      watchController.emit(ROOT, REL)
    })
    await flushPromises()

    expect(result.current.content).toBe('v2')
    expect(result.current.diskChanged).toBe(false)
  })

  it('external change when dirty → diskChanged=true, local preserved', async () => {
    let diskContent = 'v1'
    const read = vi.fn(async () => diskContent)
    const save = vi.fn(async () => undefined)

    const { result } = renderHook(
      () => useWatchedFile({ projectPath: ROOT, relPath: REL, read, save }),
      { wrapper }
    )
    await flushPromises()

    act(() => {
      result.current.setContent('local edit')
    })
    diskContent = 'external edit'
    act(() => {
      watchController.emit(ROOT, REL)
    })
    await flushPromises()

    expect(result.current.content).toBe('local edit')
    expect(result.current.diskChanged).toBe(true)
    expect(result.current.dirty).toBe(true)
  })

  it('reloadFromDisk loads disk content and clears diskChanged', async () => {
    let diskContent = 'v1'
    const read = vi.fn(async () => diskContent)
    const save = vi.fn(async () => undefined)

    const { result } = renderHook(
      () => useWatchedFile({ projectPath: ROOT, relPath: REL, read, save }),
      { wrapper }
    )
    await flushPromises()

    act(() => {
      result.current.setContent('local')
    })
    diskContent = 'v2'
    act(() => {
      watchController.emit(ROOT, REL)
    })
    await flushPromises()
    expect(result.current.diskChanged).toBe(true)

    await act(async () => {
      await result.current.reloadFromDisk()
    })
    expect(result.current.content).toBe('v2')
    expect(result.current.diskChanged).toBe(false)
    expect(result.current.dirty).toBe(false)
  })

  it('unmount while dirty flushes save', async () => {
    const read = vi.fn(async () => 'initial')
    const save = vi.fn(async () => undefined)

    const { result, unmount } = renderHook(
      () => useWatchedFile({ projectPath: ROOT, relPath: REL, read, save, debounceMs: 5000 }),
      { wrapper }
    )
    await flushPromises()

    act(() => {
      result.current.setContent('unsaved')
    })
    unmount()
    await flushPromises()

    expect(save).toHaveBeenCalledWith('unsaved')
  })

  it('dedupes concurrent flushes (no double save of identical content)', async () => {
    const read = vi.fn(async () => 'initial')
    let resolveSave: (() => void) | null = null
    const save = vi.fn(
      (_content: string) =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
        })
    )

    const { result } = renderHook(
      () => useWatchedFile({ projectPath: ROOT, relPath: REL, read, save, debounceMs: 50 }),
      { wrapper }
    )
    await flushPromises()

    act(() => {
      result.current.setContent('same')
    })
    // Kick off first save (via debounce)
    await act(async () => {
      vi.advanceTimersByTime(50)
    })
    expect(save).toHaveBeenCalledTimes(1)

    // Call onBlur while previous save is still in-flight with same content
    act(() => {
      result.current.onBlur()
    })
    await flushPromises()

    // Still only one call — dedupe prevents double-save of same content
    expect(save).toHaveBeenCalledTimes(1)

    // Finish the save
    act(() => {
      resolveSave?.()
    })
    await flushPromises()
    expect(result.current.dirty).toBe(false)
  })

  it('relPath swap flushes outgoing file before loading incoming', async () => {
    const contentMap: Record<string, string> = { 'A.md': 'A-disk', 'B.md': 'B-disk' }
    // Per-rel save closures — mirrors ProjectInstructions usage where save is
    // built via useCallback with provider in deps, so each rel has its own fn.
    const saveCalls: Array<{ rel: string; content: string }> = []
    const makeSave = (rel: string) => async (content: string) => {
      saveCalls.push({ rel, content })
      contentMap[rel] = content
    }

    const { result, rerender } = renderHook(
      ({ rel }: { rel: string }) => {
        const read = async () => contentMap[rel] ?? ''
        return useWatchedFile({
          projectPath: ROOT,
          relPath: rel,
          read,
          save: makeSave(rel),
          debounceMs: 5000
        })
      },
      { initialProps: { rel: 'A.md' }, wrapper }
    )
    await flushPromises()
    expect(result.current.content).toBe('A-disk')

    // Edit A
    act(() => {
      result.current.setContent('A-edited')
    })

    // Swap to B — cleanup should flush A through A's save closure
    rerender({ rel: 'B.md' })
    await flushPromises()

    // A was flushed via A's save closure (not B's)
    expect(saveCalls).toContainEqual({ rel: 'A.md', content: 'A-edited' })
    expect(contentMap['A.md']).toBe('A-edited')
    expect(contentMap['B.md']).toBe('B-disk')
    // B loaded
    expect(result.current.content).toBe('B-disk')
    expect(result.current.dirty).toBe(false)
  })

  it('edits during in-flight save keep dirty, trigger follow-up save', async () => {
    const read = vi.fn(async () => 'v0')
    let resolveSave: (() => void) | null = null
    const save = vi.fn(
      (_content: string) =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
        })
    )

    const { result } = renderHook(
      () => useWatchedFile({ projectPath: ROOT, relPath: REL, read, save, debounceMs: 50 }),
      { wrapper }
    )
    await flushPromises()

    // First edit → debounce → save("v1") starts, not yet resolved
    act(() => {
      result.current.setContent('v1')
    })
    await act(async () => {
      vi.advanceTimersByTime(50)
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenLastCalledWith('v1')

    // Edit more while save("v1") is in-flight
    act(() => {
      result.current.setContent('v2')
    })
    expect(result.current.dirty).toBe(true)

    // Resolve the in-flight save. Baseline must NOT update to "v1" because
    // content has since moved on to "v2" → dirty must stay true.
    await act(async () => {
      resolveSave?.()
      await Promise.resolve()
    })
    expect(result.current.dirty).toBe(true)
    expect(result.current.content).toBe('v2')

    // Next debounce fires a follow-up save with latest content
    await act(async () => {
      vi.advanceTimersByTime(50)
    })
    await flushPromises()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith('v2')
  })

  it('read() returning null leaves current content unchanged', async () => {
    const read = vi.fn(async () => null)
    const save = vi.fn(async () => undefined)

    const { result } = renderHook(
      () => useWatchedFile({ projectPath: ROOT, relPath: REL, read, save }),
      { wrapper }
    )
    await flushPromises()

    expect(result.current.content).toBe('')
    expect(result.current.dirty).toBe(false)
    expect(read).toHaveBeenCalledTimes(1)

    // Trigger reloadFromDisk — still null, still unchanged
    await act(async () => {
      await result.current.reloadFromDisk()
    })
    expect(result.current.content).toBe('')
  })

  it('null projectPath / relPath → no-op, no watcher subscription, no save', async () => {
    const read = vi.fn(async () => 'should-not-be-called')
    const save = vi.fn(async () => undefined)

    const { result, rerender } = renderHook(
      ({ rel }: { rel: string | null }) =>
        useWatchedFile({ projectPath: null, relPath: rel, read, save, debounceMs: 50 }),
      { initialProps: { rel: null as string | null }, wrapper }
    )
    await flushPromises()

    expect(read).not.toHaveBeenCalled()
    expect(watchController.everEnabled).toBe(false)
    expect(result.current.content).toBe('')

    // setContent on null-target: still dirty internally but no save ever fires
    act(() => {
      result.current.setContent('ignored')
    })
    await act(async () => {
      vi.advanceTimersByTime(50)
    })
    await flushPromises()
    expect(save).not.toHaveBeenCalled()

    // relPath provided but projectPath still null → still no-op
    rerender({ rel: REL })
    await flushPromises()
    expect(read).not.toHaveBeenCalled()
    expect(watchController.everEnabled).toBe(false)
  })

  it('target cleared while dirty → outgoing file flushed, state reset to empty + clean', async () => {
    const read = vi.fn(async () => 'A-disk')
    const save = vi.fn(async (_content: string) => undefined)

    const { result, rerender } = renderHook(
      ({ rel }: { rel: string | null }) =>
        useWatchedFile({ projectPath: ROOT, relPath: rel, read, save, debounceMs: 5000 }),
      { initialProps: { rel: 'A.md' as string | null }, wrapper }
    )
    await flushPromises()
    expect(result.current.content).toBe('A-disk')

    act(() => {
      result.current.setContent('A-edited')
    })
    // Dirty + a disk change while dirty → diskChanged banner state is set too.
    act(() => {
      watchController.emit(ROOT, 'A.md')
    })
    expect(result.current.dirty).toBe(true)
    expect(result.current.diskChanged).toBe(true)

    rerender({ rel: null })
    await flushPromises()

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('A-edited')
    expect(result.current.content).toBe('')
    expect(result.current.dirty).toBe(false)
    expect(result.current.diskChanged).toBe(false)

    // No stray debounce save, and flushNow without a target stays a no-op.
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    await flushPromises()
    await act(async () => {
      await result.current.flushNow()
    })
    expect(save).toHaveBeenCalledTimes(1)

    // Re-targeting loads the file fresh and clean.
    rerender({ rel: 'A.md' })
    await flushPromises()
    expect(result.current.content).toBe('A-disk')
    expect(result.current.dirty).toBe(false)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('own save does not trigger diskChanged banner', async () => {
    const read = vi.fn(async () => 'v1')
    // save does nothing — but the external watcher will fire as an "echo"
    const save = vi.fn(async () => undefined)

    const { result } = renderHook(
      () => useWatchedFile({ projectPath: ROOT, relPath: REL, read, save, debounceMs: 10 }),
      { wrapper }
    )
    await flushPromises()

    act(() => {
      result.current.setContent('new')
    })
    // Debounce fires → save starts
    await act(async () => {
      vi.advanceTimersByTime(10)
    })
    // Watcher echoes while savingRef is still set
    act(() => {
      watchController.emit(ROOT, REL)
    })
    await flushPromises()

    expect(result.current.diskChanged).toBe(false)
  })
})
