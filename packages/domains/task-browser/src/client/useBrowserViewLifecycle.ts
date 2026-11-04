import { useState, useEffect, useEffectEvent, useRef } from 'react'
import { callBrowserHost, getBrowserHost } from './browser-host'

interface DesktopHandoffPolicy {
  protocol: string
  hostScope?: string
}

interface UseBrowserViewLifecycleOpts {
  tabId: string
  taskId: string
  url: string
  partition?: string
  kind?: 'browser-tab' | 'web-panel'
  desktopHandoffPolicy?: DesktopHandoffPolicy | null
}

// Spawns and tears down the native web view on THIS device's browser host (never the
// hub). No host (web shell) → no view.
export function useBrowserViewLifecycle(opts: UseBrowserViewLifecycleOpts): {
  viewId: string | null
} {
  const { tabId, taskId, url, partition, kind, desktopHandoffPolicy } = opts
  const [viewId, setViewId] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const currentTabIdRef = useRef(tabId)
  // url/partition/kind/desktopHandoffPolicy are the view's initial values only:
  // read once per create (retries reuse the same snapshot), never a re-create.
  const readInitialViewOpts = useEffectEvent(() => ({ url, partition, kind, desktopHandoffPolicy }))

  useEffect(() => {
    mountedRef.current = true
    currentTabIdRef.current = tabId
    const initial = readInitialViewOpts()

    let createdViewId: string | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const tryCreate = async (): Promise<void> => {
      if (!mountedRef.current || currentTabIdRef.current !== tabId) return
      const host = getBrowserHost()
      if (!host) return

      // Promise chain, not try/catch: React Compiler can't lower value blocks
      // inside try. `.catch` after `.then` covers the same span the try did.
      return host
        .call('view.create', {
          taskId,
          tabId,
          partition: initial.partition,
          url: initial.url || 'about:blank',
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          kind: initial.kind,
          desktopHandoffPolicy: initial.desktopHandoffPolicy
        })
        .then((id) => {
          if (!id) {
            // Manager returned null (window not ready) — retry
            console.warn('[useBrowserViewLifecycle] createView returned null, retrying in 500ms')
            retryTimer = setTimeout(() => {
              if (mountedRef.current) void tryCreate()
            }, 500)
            return
          }

          if (!mountedRef.current || currentTabIdRef.current !== tabId) {
            callBrowserHost('view.destroy', id)
            return
          }

          createdViewId = id
          setViewId(id)
        })
        .catch((err) => {
          console.error('[useBrowserViewLifecycle] createView failed:', err)
          // Retry on failure (e.g., main process not ready)
          retryTimer = setTimeout(() => {
            if (mountedRef.current) void tryCreate()
          }, 500)
        })
    }

    void tryCreate()

    return () => {
      mountedRef.current = false
      if (retryTimer) clearTimeout(retryTimer)
      if (createdViewId) {
        callBrowserHost('view.destroy', createdViewId)
      }
      setViewId(null)
    }
  }, [tabId, taskId])

  return { viewId }
}
