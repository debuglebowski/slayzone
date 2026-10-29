// @vitest-environment jsdom
// Pins useBrowserFind's find-bar lifecycle: open / type / Esc, and the close on a
// browser-tab switch. The highlights live in the page of the view find ran in, so the
// clear must target THAT view — never the view of the tab being switched to.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLayoutEffect } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'

type OnData = (raw: unknown) => void
let capturedOnData: OnData | null = null
const findInPage = vi.fn((_input: unknown) => Promise.resolve())
const stopFindInPage = vi.fn((_input: unknown) => Promise.resolve())

vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    app: {
      browser: {
        onEvent: {
          subscriptionOptions: (_input: unknown, opts: { enabled: boolean; onData: OnData }) => opts
        }
      }
    }
  }),
  useTRPCClient: () => ({
    app: {
      window: { focusRenderer: { mutate: () => Promise.resolve() } },
      browser: { findInPage: { mutate: findInPage }, stopFindInPage: { mutate: stopFindInPage } }
    }
  }),
  useSubscription: (opts: { enabled: boolean; onData: OnData }) => {
    capturedOnData = opts.enabled ? opts.onData : null
  }
}))
vi.mock('./trpc', async () => await import('@slayzone/transport/client'))

const shortcuts = new Map<string, { handler: () => void; enabled: boolean }>()
vi.mock('@slayzone/ui', async (importOriginal) => ({
  useStableCallback: (await importOriginal<typeof import('@slayzone/ui')>()).useStableCallback,
  useShortcutAction: (id: string, handler: () => void, opts?: { enabled?: boolean }) => {
    shortcuts.set(id, { handler, enabled: opts?.enabled ?? true })
  }
}))

const { useBrowserFind } = await import('./useBrowserFind')

const fire = (id: string): void => {
  const s = shortcuts.get(id)
  if (!s?.enabled) throw new Error(`shortcut ${id} not enabled`)
  act(() => s.handler())
}

interface Props {
  tabId: string | null
  viewId: string | null
}

function setup(initial: Props = { tabId: 'tab-a', viewId: 'view-a' }) {
  const containerRef = { current: null }
  // Every COMMITTED (tab, findMode) pair — a layout effect only runs for a render
  // that reaches the screen, so a render React discards is not counted.
  const frames: Array<{ tabId: string | null; findMode: boolean }> = []
  const hook = renderHook(
    ({ tabId, viewId }: Props) => {
      const r = useBrowserFind({
        activeViewId: viewId,
        multiDeviceMode: false,
        extensionsManagerOpen: false,
        activeTabId: tabId,
        containerRef
      })
      const findMode = r.findMode
      useLayoutEffect(() => {
        frames.push({ tabId, findMode })
      })
      return r
    },
    { initialProps: initial }
  )
  return { ...hook, frames }
}

function openAndType(result: { current: ReturnType<typeof useBrowserFind> }, text: string) {
  fire('browser-find')
  act(() => result.current.handleFindTextChange(text))
}

afterEach(() => {
  cleanup()
  shortcuts.clear()
  capturedOnData = null
  findInPage.mockClear()
  stopFindInPage.mockClear()
})

describe('useBrowserFind — must keep working', () => {
  it('⌘F opens find; typing searches the active view; results land', () => {
    const { result } = setup()
    openAndType(result, 'foo')
    expect(result.current.findMode).toBe(true)
    expect(findInPage).toHaveBeenLastCalledWith({
      viewId: 'view-a',
      text: 'foo',
      options: { forward: true }
    })
    act(() =>
      capturedOnData!({
        viewId: 'view-a',
        type: 'found-in-page',
        finalUpdate: true,
        activeMatchOrdinal: 1,
        matches: 3
      })
    )
    expect(result.current.findResult).toEqual({ active: 1, total: 3 })
  })

  it('Enter / ⇧Enter step through matches', () => {
    const { result } = setup()
    openAndType(result, 'foo')
    fire('browser-find-next')
    expect(findInPage).toHaveBeenLastCalledWith({
      viewId: 'view-a',
      text: 'foo',
      options: { forward: true, findNext: true }
    })
    fire('browser-find-prev')
    expect(findInPage).toHaveBeenLastCalledWith({
      viewId: 'view-a',
      text: 'foo',
      options: { forward: false, findNext: true }
    })
  })

  it('Esc closes find, resets text/result and clears the highlights', () => {
    const { result } = setup()
    openAndType(result, 'foo')
    stopFindInPage.mockClear()
    fire('browser-escape')
    expect(result.current.findMode).toBe(false)
    expect(result.current.findText).toBe('')
    expect(result.current.findResult).toBeNull()
    expect(stopFindInPage).toHaveBeenCalledWith({ viewId: 'view-a', action: 'clearSelection' })
  })

  it('a browser-tab switch closes find and resets its text', () => {
    const { result, rerender } = setup()
    openAndType(result, 'foo')
    rerender({ tabId: 'tab-b', viewId: 'view-b' })
    expect(result.current.findMode).toBe(false)
    expect(result.current.findText).toBe('')
    expect(result.current.findResult).toBeNull()
  })

  it('a tab switch with find closed sends no clear', () => {
    const { rerender } = setup()
    rerender({ tabId: 'tab-b', viewId: 'view-b' })
    expect(stopFindInPage).not.toHaveBeenCalled()
  })

  it('find reopens normally on the new tab after a switch', () => {
    const { result, rerender } = setup()
    openAndType(result, 'foo')
    rerender({ tabId: 'tab-b', viewId: 'view-b' })
    openAndType(result, 'bar')
    expect(result.current.findMode).toBe(true)
    expect(findInPage).toHaveBeenLastCalledWith({
      viewId: 'view-b',
      text: 'bar',
      options: { forward: true }
    })
  })
})

describe('useBrowserFind — bugs', () => {
  it('Bug 1: a tab switch clears the highlights of the tab find ran in, not the new tab', () => {
    const { result, rerender } = setup()
    openAndType(result, 'foo')
    stopFindInPage.mockClear()
    rerender({ tabId: 'tab-b', viewId: 'view-b' })
    expect(stopFindInPage).toHaveBeenCalledWith({ viewId: 'view-a', action: 'clearSelection' })
    expect(stopFindInPage).not.toHaveBeenCalledWith({
      viewId: 'view-b',
      action: 'clearSelection'
    })
  })
})

describe('useBrowserFind — fix behaviour', () => {
  it('no frame is drawn for the new tab with find still open', () => {
    const { result, rerender, frames } = setup()
    openAndType(result, 'foo')
    rerender({ tabId: 'tab-b', viewId: 'view-b' })
    expect(frames.filter((f) => f.tabId === 'tab-b' && f.findMode)).toEqual([])
  })

  it('closing the panel with find open clears that page’s highlights', () => {
    const { result, unmount } = setup()
    openAndType(result, 'foo')
    stopFindInPage.mockClear()
    unmount()
    expect(stopFindInPage).toHaveBeenCalledWith({ viewId: 'view-a', action: 'clearSelection' })
  })
})
