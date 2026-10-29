// @vitest-environment jsdom
// - When the web-panel url cache is seeded from the task: on a task switch only.
//   A web_panel_urls change on the same task (our own debounced save echoing back)
//   must not overwrite the live cache.
// - The active artifact is saved 500 ms after it is selected (one save for a burst),
//   to the task it was selected in; a selection still waiting for its save when the
//   task changes or the page unmounts (tab closed) is saved then, not dropped.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { Task } from '@slayzone/task-contracts'

const client = { task: { update: { mutate: vi.fn((_input: unknown) => Promise.resolve()) } } }
// The domain's typed view (`../trpc`) re-exports the runtime; point it at this mock.
vi.mock('../trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({ useTRPCClient: () => client }))

const { usePersistenceSaves } = await import('./usePersistenceSaves')

afterEach(() => {
  cleanup()
  client.task.update.mutate.mockClear()
  vi.useRealTimers()
})

const task = (id: string, urls: Record<string, string> | null = null): Task =>
  ({ id, web_panel_urls: urls }) as unknown as Task

describe('usePersistenceSaves url cache', () => {
  it('seeds on a task switch, not on a same-task urls change', () => {
    const { result, rerender } = renderHook((t: Task | null) => usePersistenceSaves(t), {
      initialProps: task('a', { p: 'x' })
    })
    expect(result.current.webPanelUrlsRef.current).toEqual({ p: 'x' })

    rerender(task('a', { p: 'y' }))
    expect(result.current.webPanelUrlsRef.current).toEqual({ p: 'x' })

    rerender(task('b', { q: 'z' }))
    expect(result.current.webPanelUrlsRef.current).toEqual({ q: 'z' })

    rerender(task('c', null))
    expect(result.current.webPanelUrlsRef.current).toEqual({})
  })
})

describe('usePersistenceSaves active artifact', () => {
  const artifactSaves = () =>
    client.task.update.mutate.mock.calls
      .map(([input]) => input as { id: string; activeArtifactId?: string | null })
      .filter((input) => 'activeArtifactId' in input)

  const mount = (t: Task | null = task('a')) => {
    vi.useFakeTimers()
    return renderHook((current: Task | null) => usePersistenceSaves(current), {
      initialProps: t
    })
  }

  it('saves the last of a burst of selections once, 500 ms after it', () => {
    const { result } = mount()
    act(() => result.current.handleActiveArtifactIdChange('x'))
    act(() => vi.advanceTimersByTime(300))
    act(() => result.current.handleActiveArtifactIdChange('y'))
    act(() => vi.advanceTimersByTime(499))
    expect(artifactSaves()).toEqual([])

    act(() => vi.advanceTimersByTime(1))
    expect(artifactSaves()).toEqual([{ id: 'a', activeArtifactId: 'y' }])
  })

  it('a cleared selection is saved as null', () => {
    const { result } = mount()
    act(() => result.current.handleActiveArtifactIdChange(null))
    act(() => vi.advanceTimersByTime(500))
    expect(artifactSaves()).toEqual([{ id: 'a', activeArtifactId: null }])
  })

  it('saves nothing again at unmount once the save went out', () => {
    const { result, unmount } = mount()
    act(() => result.current.handleActiveArtifactIdChange('x'))
    act(() => vi.advanceTimersByTime(500))
    unmount()
    act(() => vi.advanceTimersByTime(1000))
    expect(artifactSaves()).toEqual([{ id: 'a', activeArtifactId: 'x' }])
  })

  it('saves nothing without a task', () => {
    const { result, unmount } = mount(null)
    act(() => result.current.handleActiveArtifactIdChange('x'))
    act(() => vi.advanceTimersByTime(500))
    unmount()
    expect(artifactSaves()).toEqual([])
  })

  it('a selection made after a task switch is saved to the new task', () => {
    const { result, rerender } = mount()
    rerender(task('b'))
    act(() => result.current.handleActiveArtifactIdChange('x'))
    act(() => vi.advanceTimersByTime(500))
    expect(artifactSaves()).toEqual([{ id: 'b', activeArtifactId: 'x' }])
  })

  it('a selection still waiting for its save is saved when the page unmounts (tab closed)', () => {
    const { result, unmount } = mount()
    act(() => result.current.handleActiveArtifactIdChange('x'))
    act(() => vi.advanceTimersByTime(100))
    unmount()
    expect(artifactSaves()).toEqual([{ id: 'a', activeArtifactId: 'x' }])

    // Once: the debounced save it replaced never fires.
    act(() => vi.advanceTimersByTime(1000))
    expect(artifactSaves()).toEqual([{ id: 'a', activeArtifactId: 'x' }])
  })

  it('a selection still waiting for its save is saved to its own task on a task switch', () => {
    const { result, rerender } = mount()
    act(() => result.current.handleActiveArtifactIdChange('x'))
    act(() => vi.advanceTimersByTime(100))
    rerender(task('b'))
    expect(artifactSaves()).toEqual([{ id: 'a', activeArtifactId: 'x' }])

    act(() => vi.advanceTimersByTime(1000))
    expect(artifactSaves()).toEqual([{ id: 'a', activeArtifactId: 'x' }])
  })
})
