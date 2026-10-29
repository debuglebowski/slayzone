// @vitest-environment jsdom
// When the native browser view is created. url/partition/kind/handoff are the
// view's INITIAL values: changing them must not re-create it, and a retry after a
// failed create reuses the values the first attempt used. A new tab/task does
// re-create it, from the values current then.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

const createView = vi.fn()
const destroyView = vi.fn(() => Promise.resolve())
const client = {
  app: { browser: { createView: { mutate: createView }, destroyView: { mutate: destroyView } } }
}
vi.mock('@slayzone/transport/client', () => ({ useTRPCClient: () => client }))

const { useBrowserViewLifecycle } = await import('./useBrowserViewLifecycle')

type Opts = Parameters<typeof useBrowserViewLifecycle>[0]
const base: Opts = { tabId: 't1', taskId: 'k1', url: 'https://a.test/', partition: 'p1' }
const flush = (): Promise<void> => act(async () => {})

beforeEach(() => {
  createView.mockReset()
  destroyView.mockClear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useBrowserViewLifecycle', () => {
  it('does not re-create the view when its initial values change', async () => {
    createView.mockResolvedValue('v1')
    const { result, rerender } = renderHook((o: Opts) => useBrowserViewLifecycle(o), {
      initialProps: base
    })
    await flush()
    expect(result.current.viewId).toBe('v1')
    rerender({ ...base, url: 'https://b.test/', partition: 'p2', kind: 'web-panel' })
    await flush()
    expect(createView).toHaveBeenCalledTimes(1)
    expect(destroyView).not.toHaveBeenCalled()
  })

  it('retries a failed create with the first attempt values', async () => {
    vi.useFakeTimers()
    createView.mockResolvedValueOnce(null).mockResolvedValue('v1')
    const { rerender } = renderHook((o: Opts) => useBrowserViewLifecycle(o), {
      initialProps: base
    })
    await flush()
    rerender({ ...base, url: 'https://b.test/' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(createView).toHaveBeenCalledTimes(2)
    expect(createView.mock.calls[1][0]).toMatchObject({ url: 'https://a.test/', partition: 'p1' })
  })

  it('re-creates from the current values on a tab change', async () => {
    createView.mockResolvedValueOnce('v1').mockResolvedValueOnce('v2')
    const { result, rerender } = renderHook((o: Opts) => useBrowserViewLifecycle(o), {
      initialProps: base
    })
    await flush()
    rerender({ ...base, tabId: 't2', url: 'https://b.test/' })
    await flush()
    expect(destroyView).toHaveBeenCalledWith({ viewId: 'v1' })
    expect(createView.mock.calls[1][0]).toMatchObject({ tabId: 't2', url: 'https://b.test/' })
    expect(result.current.viewId).toBe('v2')
  })
})
