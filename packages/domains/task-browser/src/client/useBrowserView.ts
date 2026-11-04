import { useEffect, useMemo, useRef } from 'react'
import { callBrowserHost, getBrowserHost, useBrowserHostEvent } from './browser-host'
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
  /** Keep the view painting but parked off-screen (e.g. parent task tab hidden). */
  offScreen?: boolean
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
  const {
    tabId,
    taskId,
    url,
    partition,
    visible = true,
    hidden,
    isResizing,
    offScreen,
    kind,
    desktopHandoffPolicy,
    onPopupRoute
  } = opts

  const { viewId } = useBrowserViewLifecycle({
    tabId,
    taskId,
    url,
    partition,
    kind,
    desktopHandoffPolicy
  })
  const { placeholderRef, hiddenByOverlay } = useBrowserViewBounds(viewId, {
    visible,
    hidden,
    isResizing,
    offScreen
  })
  const state = useBrowserViewEvents(viewId)

  const prevPolicyRef = useRef(desktopHandoffPolicy)
  useEffect(() => {
    if (!viewId || desktopHandoffPolicy === prevPolicyRef.current) return
    prevPolicyRef.current = desktopHandoffPolicy
    callBrowserHost('view.setHandoffPolicy', viewId, desktopHandoffPolicy ?? null)
  }, [viewId, desktopHandoffPolicy])

  // Multi-window: ensure WCV is parented to THIS window. Called on mount + on window focus
  // so the view follows whichever window currently renders the BrowserPanel.
  useEffect(() => {
    if (!viewId) return
    callBrowserHost('view.reparentToCurrentWindow', viewId)
    const onFocus = () => {
      callBrowserHost('view.reparentToCurrentWindow', viewId)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [viewId])

  // Handle web-panel:popup-request events
  useBrowserHostEvent(
    'event',
    (event) => {
      if (event.viewId !== viewId || event.type !== 'web-panel:popup-request') return
      onPopupRoute?.(event.url as string)
    },
    !!viewId
  )

  const actions: BrowserViewActions = useMemo(
    () => ({
      navigate: (u: string) => {
        if (viewId) callBrowserHost('view.navigate', viewId, u)
      },
      goBack: () => {
        if (viewId) callBrowserHost('view.goBack', viewId)
      },
      goForward: () => {
        if (viewId) callBrowserHost('view.goForward', viewId)
      },
      reload: (ignoreCache?: boolean) => {
        if (viewId) callBrowserHost('view.reload', viewId, ignoreCache)
      },
      stop: () => {
        if (viewId) callBrowserHost('view.stop', viewId)
      },
      executeJs: (code: string) => {
        const host = getBrowserHost()
        return viewId && host
          ? host.call('view.executeJs', viewId, code)
          : Promise.resolve(undefined)
      },
      insertCss: (css: string) => {
        const host = getBrowserHost()
        return viewId && host ? host.call('view.insertCss', viewId, css) : Promise.resolve('')
      },
      removeCss: (key: string) => {
        if (viewId) callBrowserHost('view.removeCss', viewId, key)
      },
      setZoom: (factor: number) => {
        if (viewId) callBrowserHost('view.setZoom', viewId, factor)
      },
      focus: () => {
        if (viewId) callBrowserHost('view.focus', viewId)
      }
    }),
    [viewId]
  )

  return { viewId, state, actions, placeholderRef, hiddenByOverlay }
}
