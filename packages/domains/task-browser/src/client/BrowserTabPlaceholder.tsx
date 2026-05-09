import { useEffect, useImperativeHandle, forwardRef } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import { useBrowserView, type BrowserViewState } from './useBrowserView'

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
  className?: string
  onStateChange?: (state: BrowserViewState) => void
  onOverlayChange?: (hidden: boolean) => void
}

export const BrowserTabPlaceholder = forwardRef<BrowserTabPlaceholderHandle, BrowserTabPlaceholderProps>(
  function BrowserTabPlaceholder({ tabId, taskId, url, partition, visible, hidden, isResizing, className, onStateChange, onOverlayChange }, ref) {
    const trpcClient = useTRPCClient()
    const { viewId, state, actions, placeholderRef, hiddenByOverlay } = useBrowserView({
      tabId,
      taskId,
      url,
      partition,
      visible,
      hidden,
      isResizing,
    })

    useImperativeHandle(ref, () => ({ viewId, state, actions, hiddenByOverlay }), [viewId, state, actions, hiddenByOverlay])

    useEffect(() => {
      if (visible) onStateChange?.(state)
    }, [visible, state, onStateChange])

    useEffect(() => {
      if (visible) onOverlayChange?.(hiddenByOverlay)
    }, [visible, hiddenByOverlay, onOverlayChange])

    // Register this tab's webContents with the main-process registry so the CLI
    // can target it. Each tab registers independently; activeness is tracked
    // separately by BrowserPanel via setActiveBrowserTab.
    useEffect(() => {
      if (!taskId || !viewId) return
      let cancelled = false
      void (async () => {
        const wcId = await trpcClient.app.browser.getWebContentsId.query({ viewId }) as number | null
        if (cancelled || wcId == null) return
        await trpcClient.app.webview.registerBrowserTab.mutate({ taskId, tabId, webContentsId: wcId })
      })()
      return () => {
        cancelled = true
        void trpcClient.app.webview.unregisterBrowserTab.mutate({ taskId, tabId })
      }
    }, [taskId, tabId, viewId])

    return (
      <div
        ref={placeholderRef}
        data-browser-panel
        data-view-id={viewId || undefined}
        data-tab-id={tabId}
        className={className}
      />
    )
  }
)
