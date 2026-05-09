import { useEffect, useMemo, useRef } from 'react'
import { useSubscription } from '@trpc/tanstack-react-query'
import { useTRPC, useTRPCClient } from '@slayzone/transport/client'
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
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()

  const { viewId } = useBrowserViewLifecycle({ tabId, taskId, url, partition, kind, desktopHandoffPolicy })
  const { placeholderRef, hiddenByOverlay } = useBrowserViewBounds(viewId, { visible, hidden, isResizing })
  const state = useBrowserViewEvents(viewId)

  // Sync handoff policy updates after initial creation
  const prevPolicyRef = useRef(desktopHandoffPolicy)
  useEffect(() => {
    if (!viewId || desktopHandoffPolicy === prevPolicyRef.current) return
    prevPolicyRef.current = desktopHandoffPolicy
    void trpcClient.app.browser.setHandoffPolicy.mutate({ viewId, policy: desktopHandoffPolicy ?? null })
  }, [viewId, desktopHandoffPolicy, trpcClient])

  // Multi-window: ensure WCV is parented to THIS window. Called on mount + on window focus
  // so the view follows whichever window currently renders the BrowserPanel.
  useEffect(() => {
    if (!viewId) return
    void trpcClient.app.browser.reparentToCurrentWindow.mutate({ viewId })
    const onFocus = () => { void trpcClient.app.browser.reparentToCurrentWindow.mutate({ viewId }) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [viewId, trpcClient])

  // Handle web-panel:popup-request events
  const onPopupRouteRef = useRef(onPopupRoute)
  onPopupRouteRef.current = onPopupRoute
  useSubscription(
    trpc.app.browser.onEvent.subscriptionOptions(undefined, {
      enabled: !!viewId && !!onPopupRoute,
      onData: (raw) => {
        const event = raw as { viewId: string; type: string; [k: string]: unknown }
        if (event.viewId !== viewId || event.type !== 'web-panel:popup-request') return
        onPopupRouteRef.current?.(event.url as string)
      },
    }),
  )

  const actions: BrowserViewActions = useMemo(() => ({
    navigate: (u: string) => { if (viewId) void trpcClient.app.browser.navigate.mutate({ viewId, url: u }) },
    goBack: () => { if (viewId) void trpcClient.app.browser.goBack.mutate({ viewId }) },
    goForward: () => { if (viewId) void trpcClient.app.browser.goForward.mutate({ viewId }) },
    reload: (ignoreCache?: boolean) => { if (viewId) void trpcClient.app.browser.reload.mutate({ viewId, ignoreCache }) },
    stop: () => { if (viewId) void trpcClient.app.browser.stop.mutate({ viewId }) },
    executeJs: (code: string) => viewId ? trpcClient.app.browser.executeJs.mutate({ viewId, code }) : Promise.resolve(undefined),
    insertCss: (css: string) => viewId ? (trpcClient.app.browser.insertCss.mutate({ viewId, css }) as Promise<string>) : Promise.resolve(''),
    removeCss: (key: string) => { if (viewId) void trpcClient.app.browser.removeCss.mutate({ viewId, key }) },
    setZoom: (factor: number) => { if (viewId) void trpcClient.app.browser.setZoom.mutate({ viewId, factor }) },
    focus: () => { if (viewId) void trpcClient.app.browser.focus.mutate({ viewId }) },
  }), [viewId, trpcClient])

  return { viewId, state, actions, placeholderRef, hiddenByOverlay }
}
