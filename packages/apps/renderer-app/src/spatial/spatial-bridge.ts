// Bridge from a spatial panel to whatever hosts it.
//
// Inside the visionOS app every panel is a WKWebView with a `slayzoneSpatial`
// script message handler; the host turns `open` into a new window the user can
// place anywhere, and `close` into dismissing this one. In a plain browser the
// same calls fall back to browser windows, so the spatial views can be
// developed and tested without a headset.
import { spatialRouteSearch, type SpatialRoute } from './spatial-route'

export type SpatialHostMessage =
  | { type: 'open'; route: SpatialRoute; url: string; title: string }
  | { type: 'close' }

/** The slice of `window` the bridge touches (injectable for tests). */
export interface SpatialHostWindow {
  location: { origin: string; pathname: string }
  open: (url: string, target: string) => unknown
  close: () => void
  webkit?: {
    messageHandlers?: {
      slayzoneSpatial?: { postMessage: (message: SpatialHostMessage) => void }
    }
  }
}

export interface SpatialBridge {
  /** True inside the native host (panels become free-floating windows). */
  isNative: boolean
  open: (route: SpatialRoute, title: string) => void
  close: () => void
}

export function createSpatialBridge(win: SpatialHostWindow): SpatialBridge {
  const handler = win.webkit?.messageHandlers?.slayzoneSpatial
  const urlFor = (route: SpatialRoute): string =>
    `${win.location.origin}${win.location.pathname}${spatialRouteSearch(route)}`

  if (handler) {
    return {
      isNative: true,
      open: (route, title) =>
        handler.postMessage({ type: 'open', route, url: urlFor(route), title }),
      close: () => handler.postMessage({ type: 'close' })
    }
  }
  return {
    isNative: false,
    open: (route) => {
      win.open(urlFor(route), '_blank')
    },
    close: () => win.close()
  }
}

/** The bridge for this page. */
export function spatialBridge(): SpatialBridge {
  return createSpatialBridge(window as unknown as SpatialHostWindow)
}
