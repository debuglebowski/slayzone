import { useEffect, useMemo, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useSubscription } from '@trpc/tanstack-react-query'
import { useTRPC } from '@slayzone/transport/client'
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
  const setHandoffPolicyMutation = useMutation(trpc.app.browser.setHandoffPolicy.mutationOptions())
  const reparentMutation = useMutation(trpc.app.browser.reparentToCurrentWindow.mutationOptions())
  const navigateMutation = useMutation(trpc.app.browser.navigate.mutationOptions())
  const goBackMutation = useMutation(trpc.app.browser.goBack.mutationOptions())
  const goForwardMutation = useMutation(trpc.app.browser.goForward.mutationOptions())
  const reloadMutation = useMutation(trpc.app.browser.reload.mutationOptions())
  const stopMutation = useMutation(trpc.app.browser.stop.mutationOptions())
  const executeJsMutation = useMutation(trpc.app.browser.executeJs.mutationOptions())
  const insertCssMutation = useMutation(trpc.app.browser.insertCss.mutationOptions())
  const removeCssMutation = useMutation(trpc.app.browser.removeCss.mutationOptions())
  const setZoomMutation = useMutation(trpc.app.browser.setZoom.mutationOptions())
  const focusMutation = useMutation(trpc.app.browser.focus.mutationOptions())

  const { viewId } = useBrowserViewLifecycle({ tabId, taskId, url, partition, kind, desktopHandoffPolicy })
  const { placeholderRef, hiddenByOverlay } = useBrowserViewBounds(viewId, { visible, hidden, isResizing })
  const state = useBrowserViewEvents(viewId)

  // Sync handoff policy updates after initial creation
  const prevPolicyRef = useRef(desktopHandoffPolicy)
  useEffect(() => {
    if (!viewId || desktopHandoffPolicy === prevPolicyRef.current) return
    prevPolicyRef.current = desktopHandoffPolicy
    setHandoffPolicyMutation.mutate({ viewId, policy: desktopHandoffPolicy ?? null })
  }, [viewId, desktopHandoffPolicy, setHandoffPolicyMutation])

  // Multi-window: ensure WCV is parented to THIS window
  useEffect(() => {
    if (!viewId) return
    reparentMutation.mutate({ viewId })
    const onFocus = () => { reparentMutation.mutate({ viewId }) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [viewId, reparentMutation])

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
    navigate: (u: string) => { if (viewId) navigateMutation.mutate({ viewId, url: u }) },
    goBack: () => { if (viewId) goBackMutation.mutate({ viewId }) },
    goForward: () => { if (viewId) goForwardMutation.mutate({ viewId }) },
    reload: (ignoreCache?: boolean) => { if (viewId) reloadMutation.mutate({ viewId, ignoreCache }) },
    stop: () => { if (viewId) stopMutation.mutate({ viewId }) },
    executeJs: (code: string) => viewId ? executeJsMutation.mutateAsync({ viewId, code }) : Promise.resolve(undefined),
    insertCss: (css: string) => viewId ? (insertCssMutation.mutateAsync({ viewId, css }) as Promise<string>) : Promise.resolve(''),
    removeCss: (key: string) => { if (viewId) removeCssMutation.mutate({ viewId, key }) },
    setZoom: (factor: number) => { if (viewId) setZoomMutation.mutate({ viewId, factor }) },
    focus: () => { if (viewId) focusMutation.mutate({ viewId }) },
  }), [viewId, navigateMutation, goBackMutation, goForwardMutation, reloadMutation, stopMutation, executeJsMutation, insertCssMutation, removeCssMutation, setZoomMutation, focusMutation])

  return { viewId, state, actions, placeholderRef, hiddenByOverlay }
}
