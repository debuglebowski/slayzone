// @vitest-environment jsdom
// Pins WebPanelView's parent sync + popup routing: URL / favicon changes reach the
// LATEST parent callbacks (OAuth/SSO URLs skipped), and in-scope popups navigate
// through the latest browser-view actions.
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

type ViewState = {
  url: string
  favicon?: string
  isLoading: boolean
  error: { description: string } | null
}
type Actions = Record<string, ReturnType<typeof vi.fn>>
const view: {
  state: ViewState
  actions: Actions
  viewId: string | null
  onPopupRoute: ((url: string) => void) | null
} = {
  state: { url: '', isLoading: false, error: null },
  actions: {},
  viewId: null,
  onPopupRoute: null
}

const makeActions = (): Actions => ({
  navigate: vi.fn(),
  setZoom: vi.fn(),
  reload: vi.fn(),
  stop: vi.fn()
})

vi.mock('@slayzone/task-browser', () => ({
  useBrowserView: (opts: { onPopupRoute: (url: string) => void }) => {
    view.onPopupRoute = opts.onPopupRoute
    return {
      viewId: view.viewId,
      state: view.state,
      actions: view.actions,
      placeholderRef: () => undefined
    }
  }
}))

const openExternal = vi.fn()
// The domain's typed view (`./trpc`) re-exports the runtime; point it at this mock.
vi.mock('./trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({
  useTRPCClient: () => ({ app: { shell: { openExternal: { mutate: openExternal } } } })
}))

vi.mock('@slayzone/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@slayzone/ui')>()
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>
  return {
    useStableCallback: actual.useStableCallback,
    IconButton: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
    Tooltip: Pass,
    TooltipTrigger: Pass,
    TooltipContent: () => null,
    useAppearance: () => ({ browserDefaultZoom: 100 }),
    safeClipboardWriteText: vi.fn()
  }
})

const { WebPanelView } = await import('./WebPanelView')

type Props = React.ComponentProps<typeof WebPanelView>
const baseProps = (over: Partial<Props> = {}): Props => ({
  taskId: 't1',
  panelId: 'panel-1',
  url: 'https://app.example.com/start',
  baseUrl: 'https://app.example.com',
  name: 'Example',
  onUrlChange: vi.fn(),
  ...over
})

beforeEach(() => {
  view.state = { url: 'https://app.example.com/start', isLoading: false, error: null }
  view.actions = makeActions()
  view.viewId = 'v1'
  view.onPopupRoute = null
  openExternal.mockReset()
  openExternal.mockResolvedValue(undefined)
})
afterEach(cleanup)

describe('WebPanelView', () => {
  it('reports real URL changes to the latest onUrlChange, skipping auth hops', () => {
    const first = vi.fn()
    const { rerender } = render(<WebPanelView {...baseProps({ onUrlChange: first })} />)
    expect(first).not.toHaveBeenCalled() // mount URL is the baseline

    view.state = { ...view.state, url: 'https://app.example.com/page' }
    rerender(<WebPanelView {...baseProps({ onUrlChange: first })} />)
    expect(first).toHaveBeenCalledWith('panel-1', 'https://app.example.com/page')

    view.state = { ...view.state, url: 'https://login.example.com/oauth/authorize?x=1' }
    rerender(<WebPanelView {...baseProps({ onUrlChange: first })} />)
    expect(first).toHaveBeenCalledTimes(1)

    const second = vi.fn()
    view.state = { ...view.state, url: 'https://app.example.com/other' }
    rerender(<WebPanelView {...baseProps({ onUrlChange: second })} />)
    expect(second).toHaveBeenCalledWith('panel-1', 'https://app.example.com/other')
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('reports favicon changes to the latest onFaviconChange (optional)', () => {
    const fav = vi.fn()
    const { rerender } = render(<WebPanelView {...baseProps()} />)
    view.state = { ...view.state, favicon: 'https://app.example.com/a.ico' }
    rerender(<WebPanelView {...baseProps()} />) // no handler: must not throw
    view.state = { ...view.state, favicon: 'https://app.example.com/b.ico' }
    rerender(<WebPanelView {...baseProps({ onFaviconChange: fav })} />)
    expect(fav.mock.calls).toEqual([['panel-1', 'https://app.example.com/b.ico']])
  })

  it('routes popups: loopback ignored, in-scope navigates via the latest actions, else external', () => {
    const props = baseProps({ blockDesktopHandoff: true, handoffHostScope: 'example.com' })
    const { rerender } = render(<WebPanelView {...props} />)

    act(() => view.onPopupRoute?.('http://localhost:3000/x'))
    expect(view.actions.navigate).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()

    const firstActions = view.actions
    act(() => view.onPopupRoute?.('https://docs.example.com/a'))
    expect(firstActions.navigate).toHaveBeenCalledWith('https://docs.example.com/a')

    // New view → new actions object; a popup now goes through the new one.
    view.viewId = 'v2'
    view.actions = makeActions()
    rerender(<WebPanelView {...props} />)
    act(() => view.onPopupRoute?.('https://docs.example.com/b'))
    expect(view.actions.navigate).toHaveBeenCalledWith('https://docs.example.com/b')
    expect(firstActions.navigate).toHaveBeenCalledTimes(1)

    act(() => view.onPopupRoute?.('https://elsewhere.org/'))
    expect(openExternal).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://elsewhere.org/' })
    )
  })

  it('applies the baseline zoom once the view exists', () => {
    render(<WebPanelView {...baseProps()} />)
    expect(view.actions.setZoom).toHaveBeenCalledWith(1)
  })
})
