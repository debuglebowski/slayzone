// @vitest-environment jsdom
// Pins DeviceWebview's emulation calls: enabled once the webview is dom-ready, and
// nothing sent on unmount — removing the <webview> destroys its guest page, and the
// emulation with it, so there is nothing to undo.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { DeviceEmulation } from '../shared'

const enableDeviceEmulation = vi.fn((_input: unknown) => Promise.resolve(true))
const disableDeviceEmulation = vi.fn((_input: unknown) => undefined)

// Stable objects: the compiled component memoizes on them.
const trpc = {
  app: {
    webview: {
      enableDeviceEmulation: { mutationOptions: () => ({ mutationFn: enableDeviceEmulation }) },
      disableDeviceEmulation: { mutationOptions: () => ({ mutationFn: disableDeviceEmulation }) }
    }
  }
}
vi.mock('./trpc', () => ({ useTRPC: () => trpc }))

const mutations = new Map<unknown, { mutate: unknown; mutateAsync: unknown }>()
vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: { mutationFn: (input: unknown) => unknown }) => {
    let m = mutations.get(opts.mutationFn)
    if (!m) {
      m = { mutate: opts.mutationFn, mutateAsync: opts.mutationFn }
      mutations.set(opts.mutationFn, m)
    }
    return m
  }
}))

vi.mock('@slayzone/platform/slz-file-url', () => ({ fileUrlToSlzFileUrl: (u: string) => u }))

const observers: Array<
  (entries: Array<{ contentRect: { width: number; height: number } }>) => void
> = []
beforeEach(() => {
  observers.length = 0
  enableDeviceEmulation.mockClear()
  disableDeviceEmulation.mockClear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: (typeof observers)[number]) {
        observers.push(cb)
      }
      observe(): void {}
      disconnect(): void {}
    }
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const { DeviceWebview } = await import('./DeviceWebview')

const preset: DeviceEmulation = {
  name: 'Phone',
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
  userAgent: 'phone-ua'
} as DeviceEmulation

async function mountReady() {
  const view = render(<DeviceWebview url="https://example.com" preset={preset} partition="p" />)
  // The webview renders only once the container has a measured size.
  act(() => observers[0]([{ contentRect: { width: 800, height: 900 } }]))
  const wv = view.container.querySelector('webview') as HTMLElement & Record<string, unknown>
  expect(wv).not.toBeNull()
  Object.assign(wv, { getWebContentsId: () => 7, reload: vi.fn() })
  await act(async () => {
    wv.dispatchEvent(new Event('dom-ready'))
  })
  return view
}

describe('DeviceWebview emulation', () => {
  it('enables emulation for the webview once it is dom-ready', async () => {
    await mountReady()
    expect(enableDeviceEmulation).toHaveBeenCalledTimes(1)
    expect(enableDeviceEmulation.mock.calls[0][0]).toMatchObject({
      webviewId: 7,
      params: { deviceScaleFactor: 3, screenPosition: 'mobile', userAgent: 'phone-ua' }
    })
  })

  it('sends no emulation call on unmount', async () => {
    const view = await mountReady()
    view.unmount()
    expect(disableDeviceEmulation).not.toHaveBeenCalled()
  })
})
