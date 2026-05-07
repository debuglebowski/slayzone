import { useCallback, useRef, useEffect, useState } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'

interface UseBrowserViewBoundsOpts {
  visible: boolean
  hidden?: boolean
  isResizing?: boolean
}

export function useBrowserViewBounds(
  viewId: string | null,
  opts: UseBrowserViewBoundsOpts
): { placeholderRef: (el: HTMLDivElement | null) => void; hiddenByOverlay: boolean } {
  const { visible, hidden, isResizing } = opts
  const effectivelyVisible = visible && !hidden && !isResizing
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

  useEffect(() => {
    let cancelled = false

    void getTrpcVanillaClient().app.meta.getZoomFactor.query().then((factor) => {
      if (!cancelled) setAppZoomFactor(factor)
    })

    const unsubscribe = window.api.app.onZoomFactorChanged((factor) => {
      setAppZoomFactor((current) => {
        if (Math.abs(current - factor) < 0.0001) return current
        lastBoundsRef.current = null
        return factor
      })
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // Sync visibility changes
  useEffect(() => {
    if (!viewId) return
    void getTrpcVanillaClient().app.browser.setVisible.mutate({ viewId, visible: effectivelyVisible })
  }, [viewId, effectivelyVisible])

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
      const overlayEls = document.querySelectorAll('[data-slot="dialog-overlay"], [data-slot="alert-dialog-overlay"], [data-radix-popper-content-wrapper]')
      const viewRect = el.getBoundingClientRect()
      let overlaps = false
      for (const oel of overlayEls) {
        const or = oel.getBoundingClientRect()
        // Two rects overlap when neither is fully left/right/above/below the other
        if (or.left < viewRect.right && or.right > viewRect.left && or.top < viewRect.bottom && or.bottom > viewRect.top) {
          overlaps = true
          break
        }
      }
      if (overlaps && !hiddenByOverlayRef.current) {
        hiddenByOverlayRef.current = true
        setHiddenByOverlay(true)
        void getTrpcVanillaClient().app.browser.setVisible.mutate({ viewId: vid, visible: false })
      } else if (!overlaps && hiddenByOverlayRef.current) {
        hiddenByOverlayRef.current = false
        setHiddenByOverlay(false)
        void getTrpcVanillaClient().app.browser.setVisible.mutate({ viewId: vid, visible: true })
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
        if (!last || last.x !== x || last.y !== y || last.width !== width || last.height !== height) {
          lastBoundsRef.current = { x, y, width, height }
          if (width > 0 && height > 0) {
            void getTrpcVanillaClient().app.browser.setBounds.mutate({ viewId: vid, bounds: { x, y, width, height } })
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(tick)
    }
  }, [])

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
      void getTrpcVanillaClient().app.browser.focus.mutate({ viewId: vid })
    }
  }, [])

  // Callback ref — handles conditional mounting
  const placeholderRef = useCallback((el: HTMLDivElement | null) => {
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
  }, [handleMouseDown, startLoop, stopLoop])

  return { placeholderRef, hiddenByOverlay }
}
