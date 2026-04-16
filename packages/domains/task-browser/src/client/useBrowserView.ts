import { useEffect, useMemo, useRef } from 'react'
import { useBrowserViewLifecycle } from './useBrowserViewLifecycle'
import { useBrowserViewBounds } from './useBrowserViewBounds'
import { useBrowserViewEvents, type BrowserViewState, type LoadError } from './useBrowserViewEvents'

export type { BrowserViewState, LoadError }

interface DesktopHandoffPolicy {
  protocol: string
  hostScope?: string
}

interface UseBrowserViewOpts {
  tabId: string
  taskId: string
  url: string
  partition?: string
  visible?: boolean
  hidden?: boolean
  isResizing?: boolean
  kind?: 'browser-tab' | 'web-panel'
  desktopHandoffPolicy?: DesktopHandoffPolicy | null
  onPopupRoute?: (url: string) => void
}

interface BrowserViewActions {
  navigate: (url: string) => void
  goBack: () => void
  goForward: () => void
  reload: (ignoreCache?: boolean) => void
  stop: () => void
  executeJs: (code: string) => Promise<unknown>
  insertCss: (css: string) => Promise<string>
  removeCss: (key: string) => void
  setZoom: (factor: number) => void
  focus: () => void
}

export function useBrowserView(opts: UseBrowserViewOpts) {
  const { tabId, taskId, url, partition, visible = true, hidden, isResizing, kind, desktopHandoffPolicy, onPopupRoute } = opts

  const { viewId } = useBrowserViewLifecycle({ tabId, taskId, url, partition, kind, desktopHandoffPolicy })
  const { placeholderRef, hiddenByOverlay } = useBrowserViewBounds(viewId, { visible, hidden, isResizing })
  const state = useBrowserViewEvents(viewId)

  // Sync handoff policy updates after initial creation
  const prevPolicyRef = useRef(desktopHandoffPolicy)
  useEffect(() => {
    if (!viewId || desktopHandoffPolicy === prevPolicyRef.current) return
    prevPolicyRef.current = desktopHandoffPolicy
    void window.api.browser.setHandoffPolicy(viewId, desktopHandoffPolicy ?? null)
  }, [viewId, desktopHandoffPolicy])

  // Handle web-panel:popup-request events
  const onPopupRouteRef = useRef(onPopupRoute)
  onPopupRouteRef.current = onPopupRoute
  useEffect(() => {
    if (!viewId || !onPopupRouteRef.current) return
    const unsub = window.api.browser.onEvent((event) => {
      if (event.viewId !== viewId || event.type !== 'web-panel:popup-request') return
      onPopupRouteRef.current?.(event.url as string)
    })
    return unsub
  }, [viewId])

  const actions: BrowserViewActions = useMemo(() => ({
    navigate: (u: string) => { if (viewId) void window.api.browser.navigate(viewId, u) },
    goBack: () => { if (viewId) void window.api.browser.goBack(viewId) },
    goForward: () => { if (viewId) void window.api.browser.goForward(viewId) },
    reload: (ignoreCache?: boolean) => { if (viewId) void window.api.browser.reload(viewId, ignoreCache) },
    stop: () => { if (viewId) void window.api.browser.stop(viewId) },
    executeJs: (code: string) => viewId ? window.api.browser.executeJs(viewId, code) : Promise.resolve(undefined),
    insertCss: (css: string) => viewId ? window.api.browser.insertCss(viewId, css) : Promise.resolve(''),
    removeCss: (key: string) => { if (viewId) void window.api.browser.removeCss(viewId, key) },
    setZoom: (factor: number) => { if (viewId) void window.api.browser.setZoom(viewId, factor) },
    focus: () => { if (viewId) void window.api.browser.focus(viewId) },
  }), [viewId])

  return { viewId, state, actions, placeholderRef, hiddenByOverlay }
}
