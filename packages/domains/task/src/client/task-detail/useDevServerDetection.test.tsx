// @vitest-environment jsdom
// Pins useDevServerDetection's toast URL: a dev-server URL from the main session (live
// or already in the buffer) surfaces once, never while the browser panel is visible, and
// opening the browser panel clears a showing one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { Task } from '@slayzone/task-contracts'

let buffer = ''
const trpcClient = {
  settings: { get: { query: async (_i: { key: string }) => null } },
  pty: { getBuffer: { query: async (_i: { sessionId: string }) => buffer } }
}
// The domain's typed view (`../trpc`) re-exports the runtime; point it at this mock.
vi.mock('../trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({ useTRPCClient: () => trpcClient }))

const { useDevServerDetection } = await import('./useDevServerDetection')

const task = { id: 't1', dev_url_toast_dismissed: false } as unknown as Task
let emit: ((url: string) => void) | null = null
const subscribeDevServer = (_sid: string, cb: (url: string) => void) => {
  emit = cb
  return () => {
    emit = null
  }
}
const getMainSessionId = (id: string) => `${id}:${id}`

beforeEach(() => {
  buffer = ''
  emit = null
})
afterEach(cleanup)

async function setup(browserVisible: boolean) {
  const hook = renderHook(
    (p: { browserVisible: boolean }) =>
      useDevServerDetection({
        task,
        browserVisible: p.browserVisible,
        settingsRevision: 0,
        subscribeDevServer,
        getMainSessionId
      }),
    { initialProps: { browserVisible } }
  )
  // Settings + buffer reads land.
  await act(async () => {})
  return hook
}
const emitUrl = (url: string) =>
  act(() => {
    emit?.(url)
  })

describe('useDevServerDetection', () => {
  it('surfaces a detected URL; opening the browser panel clears it', async () => {
    const { result, rerender } = await setup(false)
    expect(result.current.detectedDevUrl).toBe(null)
    emitUrl('http://localhost:3000')
    expect(result.current.detectedDevUrl).toBe('http://localhost:3000')
    rerender({ browserVisible: true })
    expect(result.current.detectedDevUrl).toBe(null)
    // Closing the panel again does not bring the dismissed URL back.
    rerender({ browserVisible: false })
    expect(result.current.detectedDevUrl).toBe(null)
  })

  it('surfaces nothing while the browser panel is visible, and each URL only once', async () => {
    const { result, rerender } = await setup(true)
    emitUrl('http://localhost:3000')
    expect(result.current.detectedDevUrl).toBe(null)
    rerender({ browserVisible: false })
    emitUrl('http://localhost:4000')
    expect(result.current.detectedDevUrl).toBe('http://localhost:4000')
    act(() => result.current.setDetectedDevUrl(null))
    emitUrl('http://localhost:4000')
    expect(result.current.detectedDevUrl).toBe(null)
  })

  it('surfaces a URL already in the session buffer on mount', async () => {
    buffer = 'ready on http://0.0.0.0:5173\n'
    const { result } = await setup(false)
    expect(result.current.detectedDevUrl).toBe('http://localhost:5173')
  })
})
