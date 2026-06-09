// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

// tRPC mock — the hook subscribes via useSubscription(trpc.app.browser.onEvent
// .subscriptionOptions(...)). subscriptionOptions passes its opts through so the
// useSubscription mock can capture onData and the test can feed events directly.
type OnData = (raw: unknown) => void
let capturedOnData: OnData | null = null

vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    app: {
      browser: {
        onEvent: {
          subscriptionOptions: (_input: unknown, opts: { enabled: boolean; onData: OnData }) =>
            opts
        }
      }
    }
  }),
  useSubscription: (opts: { enabled: boolean; onData: OnData }) => {
    if (opts.enabled) capturedOnData = opts.onData
  }
}))

import { useBrowserViewEvents } from './useBrowserViewEvents'

const feed = (event: Record<string, unknown>): void => {
  act(() => capturedOnData!(event))
}

const snapshot = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  viewId: 'bv-1',
  type: 'state-snapshot',
  url: 'https://example.com/',
  title: 'Example',
  favicon: null,
  canGoBack: false,
  canGoForward: true,
  isLoading: false,
  domReady: true,
  hasLoadedRealPage: true,
  error: null,
  ...overrides
})

beforeEach(() => {
  capturedOnData = null
})

describe('useBrowserViewEvents state-snapshot replay', () => {
  it('populates nav state from a snapshot (heals events missed before subscribe)', () => {
    const { result } = renderHook(() => useBrowserViewEvents('bv-1'))
    expect(result.current.hasLoadedRealPage).toBe(false)

    feed(snapshot())

    expect(result.current.url).toBe('https://example.com/')
    expect(result.current.title).toBe('Example')
    expect(result.current.canGoForward).toBe(true)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.domReady).toBe(true)
    expect(result.current.hasLoadedRealPage).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('ignores snapshots for other views', () => {
    const { result } = renderHook(() => useBrowserViewEvents('bv-1'))

    feed(snapshot({ viewId: 'bv-2' }))

    expect(result.current.url).toBe('')
    expect(result.current.hasLoadedRealPage).toBe(false)
  })

  it('applies live events on top of a snapshot', () => {
    const { result } = renderHook(() => useBrowserViewEvents('bv-1'))

    feed(snapshot())
    feed({
      viewId: 'bv-1',
      type: 'did-navigate',
      url: 'https://example.com/next',
      canGoBack: true,
      canGoForward: false
    })

    expect(result.current.url).toBe('https://example.com/next')
    expect(result.current.canGoBack).toBe(true)
    // sticky — survives later navigations
    expect(result.current.hasLoadedRealPage).toBe(true)
  })

  it('mid-load snapshot + live dom-ready completes hasLoadedRealPage', () => {
    const { result } = renderHook(() => useBrowserViewEvents('bv-1'))

    // Snapshot taken while the page is still loading: url known (did-navigate
    // was missed), dom-ready not yet fired in main.
    feed(snapshot({ isLoading: true, domReady: false, hasLoadedRealPage: false }))
    expect(result.current.hasLoadedRealPage).toBe(false)

    feed({ viewId: 'bv-1', type: 'dom-ready' })

    expect(result.current.domReady).toBe(true)
    expect(result.current.hasLoadedRealPage).toBe(true)
  })

  it('surfaces a load error carried by the snapshot', () => {
    const { result } = renderHook(() => useBrowserViewEvents('bv-1'))

    feed(
      snapshot({
        hasLoadedRealPage: false,
        domReady: false,
        error: { code: -105, description: 'ERR_NAME_NOT_RESOLVED', url: 'https://nope.example/' }
      })
    )

    expect(result.current.error).toEqual({
      code: -105,
      description: 'ERR_NAME_NOT_RESOLVED',
      url: 'https://nope.example/'
    })
  })
})
