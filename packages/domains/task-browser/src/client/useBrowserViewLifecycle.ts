import { useState, useEffect, useRef } from 'react'

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

export function useBrowserViewLifecycle(opts: UseBrowserViewLifecycleOpts): { viewId: string | null } {
  const { tabId, taskId, url, partition, kind, desktopHandoffPolicy } = opts
  const [viewId, setViewId] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const currentTabIdRef = useRef(tabId)

  useEffect(() => {
    mountedRef.current = true
    currentTabIdRef.current = tabId

    let createdViewId: string | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const tryCreate = async (): Promise<void> => {
      if (!mountedRef.current || currentTabIdRef.current !== tabId) return

      try {
        const id = await window.api.browser.createView({
          taskId,
          tabId,
          partition,
          url: url || 'about:blank',
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          kind,
          desktopHandoffPolicy,
        })

        if (!id) {
          // Manager returned null (window not ready) — retry
          console.warn('[useBrowserViewLifecycle] createView returned null, retrying in 500ms')
          retryTimer = setTimeout(() => { if (mountedRef.current) void tryCreate() }, 500)
          return
        }

        if (!mountedRef.current || currentTabIdRef.current !== tabId) {
          void window.api.browser.destroyView(id)
          return
        }

        createdViewId = id
        setViewId(id)
      } catch (err) {
        console.error('[useBrowserViewLifecycle] createView failed:', err)
        // Retry on failure (e.g., main process not ready)
        retryTimer = setTimeout(() => { if (mountedRef.current) void tryCreate() }, 500)
      }
    }

    void tryCreate()

    return () => {
      mountedRef.current = false
      if (retryTimer) clearTimeout(retryTimer)
      if (createdViewId) {
        void window.api.browser.destroyView(createdViewId)
      }
      setViewId(null)
    }
  }, [tabId, taskId]) // eslint-disable-line react-hooks/exhaustive-deps — url/partition are initial values only

  return { viewId }
}
