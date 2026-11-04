import { useEffect, useImperativeHandle, forwardRef } from 'react'
import { callBrowserHost, getBrowserHost } from './browser-host'
import { useBrowserRelayHostHandle } from './useBrowserRelayHost'
import { useBrowserView, type BrowserViewState } from './useBrowserView'
import type { BrowserTabTheme } from '../shared'

/** The reactive part of a tab's handle: which view it owns and how to drive it. */
export interface BrowserTabView {
  viewId: string | null
  actions: BrowserTabPlaceholderHandle['actions']
}

export interface BrowserTabPlaceholderHandle {
  viewId: string | null
  state: BrowserViewState
  hiddenByOverlay: boolean
  actions: {
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
}

interface BrowserTabPlaceholderProps {
  tabId: string
  taskId: string
  url: string
  partition?: string
  visible: boolean
  hidden?: boolean
  isResizing?: boolean
  /** When true, keep view painting but park bounds off-screen. */
  offScreen?: boolean
  /** Agent lock: when true, OS-origin input is silenced for this WCV. */
  locked?: boolean
  /** Forced color scheme, or 'system'/undefined to follow the OS. */
  themeMode?: BrowserTabTheme
  className?: string
  onStateChange?: (state: BrowserViewState) => void
  onOverlayChange?: (hidden: boolean) => void
  /** Reports this tab's viewId/actions whenever they change; `null` on unmount. */
  onViewChange?: (tabId: string, view: BrowserTabView | null) => void
}

export const BrowserTabPlaceholder = forwardRef<
  BrowserTabPlaceholderHandle,
  BrowserTabPlaceholderProps
>(function BrowserTabPlaceholder(
  {
    tabId,
    taskId,
    url,
    partition,
    visible,
    hidden,
    isResizing,
    offScreen,
    locked,
    themeMode,
    className,
    onStateChange,
    onOverlayChange,
    onViewChange
  },
  ref
) {
  const relayHost = useBrowserRelayHostHandle()

  const { viewId, state, actions, placeholderRef, hiddenByOverlay } = useBrowserView({
    tabId,
    taskId,
    url,
    partition,
    visible,
    hidden,
    isResizing,
    offScreen
  })

  useImperativeHandle(ref, () => ({ viewId, state, actions, hiddenByOverlay }), [
    viewId,
    state,
    actions,
    hiddenByOverlay
  ])

  useEffect(() => {
    if (!onViewChange) return
    onViewChange(tabId, { viewId, actions })
    return () => onViewChange(tabId, null)
  }, [tabId, viewId, actions, onViewChange])

  useEffect(() => {
    if (visible) onStateChange?.(state)
  }, [visible, state, onStateChange])

  useEffect(() => {
    if (visible) onOverlayChange?.(hiddenByOverlay)
  }, [visible, hiddenByOverlay, onOverlayChange])

  // Register this tab's webContents with this device's tab registry, then tell the
  // hub this client has it live — so `slay browser` can target it. Each tab registers
  // independently; activeness is tracked separately by BrowserPanel.
  useEffect(() => {
    const host = getBrowserHost()
    if (!taskId || !viewId || !host) return
    let cancelled = false
    let live = false
    host
      .call('view.getWebContentsId', viewId)
      .then(async (wcId) => {
        if (cancelled || wcId == null) return
        await host.call('tabs.register', taskId, tabId, wcId)
        if (cancelled) return
        live = true
        relayHost?.tabLive(tabId)
      })
      .catch((err: unknown) => console.warn('[browser] tab registration failed:', err))
    return () => {
      cancelled = true
      if (live) relayHost?.tabGone(tabId)
      callBrowserHost('tabs.unregister', taskId, tabId)
    }
  }, [taskId, tabId, viewId, relayHost])

  useEffect(() => {
    if (!viewId) return
    callBrowserHost('view.setLocked', viewId, !!locked)
  }, [viewId, locked])

  // Declare the desired theme; the main process owns applying and re-applying
  // it. `viewId` is a dependency on purpose — a re-created view (remount, LRU
  // eviction, crash recovery) re-declares itself rather than coming back
  // unthemed.
  useEffect(() => {
    if (!viewId) return
    callBrowserHost(
      'view.setForcedTheme',
      viewId,
      !themeMode || themeMode === 'system' ? null : themeMode
    )
  }, [viewId, themeMode])

  return (
    <div
      ref={placeholderRef}
      data-browser-panel
      data-view-id={viewId || undefined}
      data-tab-id={tabId}
      className={className}
    />
  )
})
