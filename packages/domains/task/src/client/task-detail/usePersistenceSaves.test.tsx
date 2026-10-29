// @vitest-environment jsdom
// When the web-panel url cache is seeded from the task: on a task switch only.
// A web_panel_urls change on the same task (our own debounced save echoing back)
// must not overwrite the live cache.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import type { Task } from '@slayzone/task-contracts'

const client = { task: { update: { mutate: vi.fn(() => Promise.resolve()) } } }
// The domain's typed view (`../trpc`) re-exports the runtime; point it at this mock.
vi.mock('../trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({ useTRPCClient: () => client }))

const { usePersistenceSaves } = await import('./usePersistenceSaves')

afterEach(cleanup)

const task = (id: string, urls: Record<string, string> | null): Task =>
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
