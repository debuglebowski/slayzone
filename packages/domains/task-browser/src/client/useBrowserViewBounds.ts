import { useCallback, useRef, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSubscription, useTRPC, useTRPCClient } from '@slayzone/transport/client'

interface UseBrowserViewBoundsOpts {
  visible: boolean
  hidden?: boolean
  isResizing?: boolean
  /** When true, keep the view painting (so video keeps playing) but park its
   *  bounds off-screen so it doesn't overlap whatever the user is now looking
   *  at. Used when the parent task tab is hidden. */
  offScreen?: boolean
}

const OFF_SCREEN_X = -20000
const OFF_SCREEN_Y = -20000
const FALLBACK_PARK_WIDTH = 800
const FALLBACK_PARK_HEIGHT = 600

export function useBrowserViewBounds(
  viewId: string | null,
  opts: UseBrowserViewBoundsOpts
): { placeholderRef: (el: HTMLDivElement | null) => void; hiddenByOverlay: boolean } {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const { visible, hidden, isResizing, offScreen } = opts
  const shouldPaint = visible && !hidden && !isResizing
  const effectivelyVisible = shouldPaint && !offScreen
  const [appZoomFactor, setAppZoomFactor] = useState(1)

  const elementRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number>(0)
  const lastBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const viewIdRef = useRef(viewId)
  const effectivelyVisibleRef = useRef(effectivelyVisible)
  const appZoomFactorRef = useRef(appZoomFactor)

  viewIdRef.current = viewId
  effectivelyVisibleRef.current = effectivelyVisible
  appZoomFactorRef.current = appZoomFactor

  // Initial app zoom factor — app.meta.getZoomFactor mirrors app:get-zoom-factor.
  const zoomQuery = useQuery(trpc.app.meta.getZoomFactor.queryOptions())
  useEffect(() => {
    if (typeof zoomQuery.data === 'number') setAppZoomFactor(zoomQuery.data)
  }, [zoomQuery.data])

  // Live zoom changes — menu.onZoomFactorChanged mirrors app:zoom-factor-changed.
  useSubscription(
    trpc.menu.onZoomFactorChanged.subscriptionOptions(undefined, {
      onData: (factor) => {
        setAppZoomFactor((current) => {
          if (Math.abs(current - factor) < 0.0001) return current
          lastBoundsRef.current = null
          return factor
        })
      }
    })
  )

  // Sync visibility changes — drives WCV painting independent of bounds. When
  // shouldPaint is true but offScreen is true, the view keeps painting (video
  // plays) while parked off-screen by the bounds effect below.
  useEffect(() => {
    if (!viewId) return
    void trpcClient.app.browser.setVisible.mutate({ viewId, visible: shouldPaint })
  }, [viewId, shouldPaint, trpcClient])

  // Park bounds off-screen when shouldPaint && offScreen. One-shot per transition:
  // the rAF loop is gated on effectivelyVisible (= !offScreen), so it won't fight
  // this placement. Reuse the last on-screen w/h so the page's layout (and thus
  // any video player sizing) doesn't reflow on park — only x/y move.
  useEffect(() => {
    if (!viewId || !shouldPaint || !offScreen) return
    const last = lastBoundsRef.current
    const width = last?.width && last.width > 0 ? last.width : FALLBACK_PARK_WIDTH
    const height = last?.height && last.height > 0 ? last.height : FALLBACK_PARK_HEIGHT
    void trpcClient.app.browser.setBounds.mutate({
      viewId,
      bounds: {
      x: OFF_SCREEN_X,
      y: OFF_SCREEN_Y,
      width,
      height
      }
    })
    lastBoundsRef.current = null
  }, [viewId, shouldPaint, offScreen, trpcClient])

  // Track whether we've hidden this view due to a dialog overlay
  const [hiddenByOverlay, setHiddenByOverlay] = useState(false)
  const hiddenByOverlayRef = useRef(false)

  // rAF bounds tracking loop
  const startLoop = useCallback(() => {
    const tick = () => {
      const el = elementRef.current
      const vid = viewIdRef.current
      if (!el || !vid || !effectivelyVisibleRef.current) {
        // Reset overlay state so we don't get stuck hidden when loop restarts
        if (hiddenByOverlayRef.current) {
          hiddenByOverlayRef.current = false
          setHiddenByOverlay(false)
        }
        rafRef.current = 0
        return
      }

      // Check if a dialog overlay or popover overlaps this view
      const overlayEls = document.querySelectorAll(
        '[data-slot="dialog-overlay"], [data-slot="alert-dialog-overlay"], [data-radix-popper-content-wrapper], [data-slot="sidebar-reveal-overlay"]'
      )
      const viewRect = el.getBoundingClientRect()
      let overlaps = false
      for (const oel of overlayEls) {
        const or = oel.getBoundingClientRect()
        // Two rects overlap when neither is fully left/right/above/below the other
        if (
          or.left < viewRect.right &&
          or.right > viewRect.left &&
          or.top < viewRect.bottom &&
          or.bottom > viewRect.top
        ) {
          overlaps = true
          break
        }
      }
      if (overlaps && !hiddenByOverlayRef.current) {
        hiddenByOverlayRef.current = true
        setHiddenByOverlay(true)
        void trpcClient.app.browser.setVisible.mutate({ viewId: vid, visible: false })
      } else if (!overlaps && hiddenByOverlayRef.current) {
        hiddenByOverlayRef.current = false
        setHiddenByOverlay(false)
        void trpcClient.app.browser.setVisible.mutate({ viewId: vid, visible: true })
      }

      // Only sync bounds when not hidden by overlay
      if (!hiddenByOverlayRef.current) {
        const zoomFactor = appZoomFactorRef.current
        // DOM rects are reported in the renderer's CSS-space, while the native
        // WebContentsView expects window-space coordinates. App zoom changes the
        // mapping between those spaces, so we apply the current zoom factor here.
        const x = Math.round(viewRect.left * zoomFactor)
        const y = Math.round(viewRect.top * zoomFactor)
        const width = Math.round(viewRect.width * zoomFactor)
        const height = Math.round(viewRect.height * zoomFactor)

        const last = lastBoundsRef.current
        if (
          !last ||
          last.x !== x ||
          last.y !== y ||
          last.width !== width ||
          last.height !== height
        ) {
          lastBoundsRef.current = { x, y, width, height }
          if (width > 0 && height > 0) {
            void trpcClient.app.browser.setBounds.mutate({
              viewId: vid,
              bounds: { x, y, width, height }
            })
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(tick)
    }
  }, [trpcClient])

  const stopLoop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [])

  // Start/stop loop when visibility or viewId changes
  useEffect(() => {
    if (viewId && effectivelyVisible && elementRef.current) {
      startLoop()
    } else {
      stopLoop()
    }
    return stopLoop
  }, [viewId, effectivelyVisible, startLoop, stopLoop, appZoomFactor])

  // Focus bridge: mousedown on placeholder focuses the view
  const handleMouseDown = useCallback(() => {
    const vid = viewIdRef.current
    if (vid) {
      void trpcClient.app.browser.focus.mutate({ viewId: vid })
    }
  }, [trpcClient])

  // Callback ref — handles conditional mounting
  const placeholderRef = useCallback(
    (el: HTMLDivElement | null) => {
      const prev = elementRef.current
      elementRef.current = el

      if (el && !prev) {
        // Attached — start loop if conditions met
        el.addEventListener('mousedown', handleMouseDown)
        if (viewIdRef.current && effectivelyVisibleRef.current) {
          lastBoundsRef.current = null // force initial sync
          startLoop()
        }
      } else if (!el && prev) {
        // Detached — stop loop
        prev.removeEventListener('mousedown', handleMouseDown)
        stopLoop()
        lastBoundsRef.current = null
      }
    },
    [handleMouseDown, startLoop, stopLoop]
  )

  return { placeholderRef, hiddenByOverlay }
}
