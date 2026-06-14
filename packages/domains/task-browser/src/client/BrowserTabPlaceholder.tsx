import { useEffect, useImperativeHandle, forwardRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
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
  /** When true, keep view painting but park bounds off-screen. */
  offScreen?: boolean
  /** Agent lock: when true, OS-origin input is silenced for this WCV. */
  locked?: boolean
  className?: string
  onStateChange?: (state: BrowserViewState) => void
  onOverlayChange?: (hidden: boolean) => void
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
    className,
    onStateChange,
    onOverlayChange
  },
  ref
) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const registerTab = useMutation(trpc.app.webview.registerBrowserTab.mutationOptions()).mutateAsync
  const unregisterTab = useMutation(
    trpc.app.webview.unregisterBrowserTab.mutationOptions()
  ).mutate
  const setViewLocked = useMutation(trpc.app.browser.setLocked.mutationOptions()).mutate

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
      const wcId = (await queryClient.fetchQuery(
        trpc.app.browser.getWebContentsId.queryOptions({ viewId })
      )) as number | null
      if (cancelled || wcId == null) return
      await registerTab({ taskId, tabId, webContentsId: wcId })
    })()
    return () => {
      cancelled = true
      unregisterTab({ taskId, tabId })
    }
  }, [taskId, tabId, viewId, queryClient, trpc, registerTab, unregisterTab])

  useEffect(() => {
    if (!viewId) return
    setViewLocked({ viewId, locked: !!locked })
  }, [viewId, locked, setViewLocked])

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
