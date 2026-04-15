// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useWatchedFile } from './useWatchedFile'

type FileChangedCallback = (rootPath: string, relPath: string) => void

interface FsStub {
  watch: ReturnType<typeof vi.fn>
  unwatch: ReturnType<typeof vi.fn>
  onFileChanged: ReturnType<typeof vi.fn>
  emit: (root: string, rel: string) => void
}

function installFsStub(): FsStub {
  const listeners = new Set<FileChangedCallback>()
  const stub: FsStub = {
    watch: vi.fn(async () => undefined),
    unwatch: vi.fn(async () => undefined),
    onFileChanged: vi.fn((cb: FileChangedCallback) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }),
    emit: (root, rel) => {
      for (const cb of listeners) cb(root, rel)
    },
  }
  ;(globalThis as unknown as { window: { api: { fs: unknown } } }).window = { api: { fs: stub } }
  return stub
}

const ROOT = '/tmp/proj'
const REL = 'CLAUDE.md'

let fsStub: FsStub

beforeEach(() => {
  fsStub = installFsStub()
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
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

    const { result } = renderHook(() =>
      useWatchedFile({ projectPath: ROOT, relPath: REL, read, save })
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

    const { result } = renderHook(() =>
      useWatchedFile({ projectPath: ROOT, relPath: REL, read, save, debounceMs: 100 })
    )
    await flushPromises()

    act(() => { result.current.setContent('new') })
    expect(result.current.dirty).toBe(true)
    expect(save).not.toHaveBeenCalled()

    await act(async () => { vi.advanceTimersByTime(100) })
    await flushPromises()

    expect(save).toHaveBeenCalledWith('new')
    expect(result.current.dirty).toBe(false)
  })

  it('onBlur flushes immediately without waiting for debounce', async () => {
    const read = vi.fn(async () => 'old')
    const save = vi.fn(async () => undefined)

    const { result } = renderHook(() =>
      useWatchedFile({ projectPath: ROOT, relPath: REL, read, save, debounceMs: 500 })
    )
    await flushPromises()

    act(() => { result.current.setContent('blurred') })
    await act(async () => { await result.current.onBlur() })

    expect(save).toHaveBeenCalledWith('blurred')
    expect(result.current.dirty).toBe(false)
  })

  it('external change when clean → silent reload', async () => {
    let diskContent = 'v1'
    const read = vi.fn(async () => diskContent)
    const save = vi.fn(async () => undefined)

    const { result } = renderHook(() =>
      useWatchedFile({ projectPath: ROOT, relPath: REL, read, save })
    )
    await flushPromises()
    expect(result.current.content).toBe('v1')

    diskContent = 'v2'
    act(() => { fsStub.emit(ROOT, REL) })
    await flushPromises()

    expect(result.current.content).toBe('v2')
    expect(result.current.diskChanged).toBe(false)
  })

  it('external change when dirty → diskChanged=true, local preserved', async () => {
    let diskContent = 'v1'
    const read = vi.fn(async () => diskContent)
    const save = vi.fn(async () => undefined)

    const { result } = renderHook(() =>
      useWatchedFile({ projectPath: ROOT, relPath: REL, read, save })
    )
    await flushPromises()

    act(() => { result.current.setContent('local edit') })
    diskContent = 'external edit'
    act(() => { fsStub.emit(ROOT, REL) })
    await flushPromises()

    expect(result.current.content).toBe('local edit')
    expect(result.current.diskChanged).toBe(true)
    expect(result.current.dirty).toBe(true)
  })

  it('reloadFromDisk loads disk content and clears diskChanged', async () => {
    let diskContent = 'v1'
    const read = vi.fn(async () => diskContent)
    const save = vi.fn(async () => undefined)

    const { result } = renderHook(() =>
      useWatchedFile({ projectPath: ROOT, relPath: REL, read, save })
    )
    await flushPromises()

    act(() => { result.current.setContent('local') })
    diskContent = 'v2'
    act(() => { fsStub.emit(ROOT, REL) })
    await flushPromises()
    expect(result.current.diskChanged).toBe(true)

    await act(async () => { await result.current.reloadFromDisk() })
    expect(result.current.content).toBe('v2')
    expect(result.current.diskChanged).toBe(false)
    expect(result.current.dirty).toBe(false)
  })

  it('unmount while dirty flushes save', async () => {
    const read = vi.fn(async () => 'initial')
    const save = vi.fn(async () => undefined)

    const { result, unmount } = renderHook(() =>
      useWatchedFile({ projectPath: ROOT, relPath: REL, read, save, debounceMs: 5000 })
    )
    await flushPromises()

    act(() => { result.current.setContent('unsaved') })
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

    const { result } = renderHook(() =>
      useWatchedFile({ projectPath: ROOT, relPath: REL, read, save, debounceMs: 50 })
    )
    await flushPromises()

    act(() => { result.current.setContent('same') })
    // Kick off first save (via debounce)
    await act(async () => { vi.advanceTimersByTime(50) })
    expect(save).toHaveBeenCalledTimes(1)

    // Call onBlur while previous save is still in-flight with same content
    act(() => { result.current.onBlur() })
    await flushPromises()

    // Still only one call — dedupe prevents double-save of same content
    expect(save).toHaveBeenCalledTimes(1)

    // Finish the save
    act(() => { resolveSave?.() })
    await flushPromises()
    expect(result.current.dirty).toBe(false)
  })

  it('relPath swap flushes outgoing file before loading incoming', async () => {
    const contentMap: Record<string, string> = { 'A.md': 'A-disk', 'B.md': 'B-disk' }
    // Per-rel save closures — mirrors ProjectInstructions usage where save is
    // built via useCallback with provider in deps, so each rel has its own fn.
    const saveCalls: Array<{ rel: string; content: string }> = []
    const makeSave = (rel: string) =>
      async (content: string) => {
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
          debounceMs: 5000,
        })
      },
      { initialProps: { rel: 'A.md' } }
    )
    await flushPromises()
    expect(result.current.content).toBe('A-disk')

    // Edit A
    act(() => { result.current.setContent('A-edited') })

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

    const { result } = renderHook(() =>
      useWatchedFile({ projectPath: ROOT, relPath: REL, read, save, debounceMs: 50 })
    )
    await flushPromises()

    // First edit → debounce → save("v1") starts, not yet resolved
    act(() => { result.current.setContent('v1') })
    await act(async () => { vi.advanceTimersByTime(50) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenLastCalledWith('v1')

    // Edit more while save("v1") is in-flight
    act(() => { result.current.setContent('v2') })
    expect(result.current.dirty).toBe(true)

    // Resolve the in-flight save. Baseline must NOT update to "v1" because
    // content has since moved on to "v2" → dirty must stay true.
    await act(async () => { resolveSave?.(); await Promise.resolve() })
    expect(result.current.dirty).toBe(true)
    expect(result.current.content).toBe('v2')

    // Next debounce fires a follow-up save with latest content
    await act(async () => { vi.advanceTimersByTime(50) })
    await flushPromises()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith('v2')
  })

  it('read() returning null leaves current content unchanged', async () => {
    const read = vi.fn(async () => null)
    const save = vi.fn(async () => undefined)

    const { result } = renderHook(() =>
      useWatchedFile({ projectPath: ROOT, relPath: REL, read, save })
    )
    await flushPromises()

    expect(result.current.content).toBe('')
    expect(result.current.dirty).toBe(false)
    expect(read).toHaveBeenCalledTimes(1)

    // Trigger reloadFromDisk — still null, still unchanged
    await act(async () => { await result.current.reloadFromDisk() })
    expect(result.current.content).toBe('')
  })

  it('null projectPath / relPath → no-op, no watcher subscription, no save', async () => {
    const read = vi.fn(async () => 'should-not-be-called')
    const save = vi.fn(async () => undefined)

    const { result, rerender } = renderHook(
      ({ rel }: { rel: string | null }) =>
        useWatchedFile({ projectPath: null, relPath: rel, read, save, debounceMs: 50 })
    , { initialProps: { rel: null as string | null } })
    await flushPromises()

    expect(read).not.toHaveBeenCalled()
    expect(fsStub.watch).not.toHaveBeenCalled()
    expect(result.current.content).toBe('')

    // setContent on null-target: still dirty internally but no save ever fires
    act(() => { result.current.setContent('ignored') })
    await act(async () => { vi.advanceTimersByTime(50) })
    await flushPromises()
    expect(save).not.toHaveBeenCalled()

    // relPath provided but projectPath still null → still no-op
    rerender({ rel: REL })
    await flushPromises()
    expect(read).not.toHaveBeenCalled()
    expect(fsStub.watch).not.toHaveBeenCalled()
  })

  it('own save does not trigger diskChanged banner', async () => {
    const read = vi.fn(async () => 'v1')
    // save does nothing — but the external watcher will fire as an "echo"
    const save = vi.fn(async () => undefined)

    const { result } = renderHook(() =>
      useWatchedFile({ projectPath: ROOT, relPath: REL, read, save, debounceMs: 10 })
    )
    await flushPromises()

    act(() => { result.current.setContent('new') })
    // Debounce fires → save starts
    await act(async () => { vi.advanceTimersByTime(10) })
    // Watcher echoes while savingRef is still set
    act(() => { fsStub.emit(ROOT, REL) })
    await flushPromises()

    expect(result.current.diskChanged).toBe(false)
  })
})
