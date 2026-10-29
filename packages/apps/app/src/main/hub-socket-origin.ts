/**
 * The app renderer's hub sockets reach the hub as a NATIVE client: no `Origin`.
 *
 * WHY. A hub that other machines can reach and that requires login refuses a
 * `/trpc` upgrade whose `Origin` is not its own web page (hub `ws-origin.ts`
 * `wsOriginDecision`). The renderer opens its tRPC sockets itself, so Chromium
 * stamps them with the renderer's origin — `file://` packaged, the dev server's
 * `http://localhost:<port>` in dev — and every one was refused (`authz.denied`,
 * `reason: origin`): signed in, but "could not reach this hub".
 *
 * WHY THIS KEEPS THE HUB'S GUARD WHOLE. The guard stops a BROWSER PAGE being a
 * confused deputy: a page cannot remove `Origin`, so an Origin-less socket is never
 * one a website opened. This removes it in the main process, from sockets the app's
 * own document opened and no other page's. Those sockets authenticate the way every
 * native client does, with the bearer in tRPC `connectionParams`, which the renderer
 * gets from main (`app:get-hub-tokens`); no cookie, since the hub honours its web
 * session cookie only when `Origin` is its own page (`cookieOriginDecision`) and an
 * absent one never is. Nothing about the hub changes, so the same app works against
 * a hub that is already deployed.
 *
 * WHAT IS LEFT ALONE. Any page that is not the app document (webview popups share
 * this session; artifact iframes are `slz-file:`), any socket not on a hub's `/trpc`
 * (Convex, Vite HMR), any other resource. Dev and packaged builds take the same path;
 * only the app document's URL differs.
 *
 * `webRequest` keeps ONE `onBeforeSendHeaders` listener per session; this is the
 * default session's only one. A second must be merged into it, or it replaces this.
 *
 * @module main/hub-socket-origin
 */
import type { Session } from 'electron'
import { isAppDocument } from './app-window-navigation-guard'

/** The hub's client socket path (hub `server.ts`; registry URLs are `ws(s)://host[:port]/trpc`). */
const HUB_TRPC_PATH = '/trpc'

export interface HubSocketRequest {
  /** Electron's `details.resourceType`. */
  resourceType: string
  url: string
  /** URL of the frame that opened the request, when Electron reports one. */
  frameUrl: string | undefined
}

/** Should this request reach the hub without an `Origin` header? */
export function shouldStripHubSocketOrigin(req: HubSocketRequest, appDocumentUrl: string): boolean {
  if (req.resourceType !== 'webSocket') return false
  if (!req.frameUrl || !isAppDocument(appDocumentUrl, req.frameUrl)) return false
  let u: URL
  try {
    u = new URL(req.url)
  } catch {
    return false
  }
  return (u.protocol === 'ws:' || u.protocol === 'wss:') && u.pathname === HUB_TRPC_PATH
}

/** The URL of the frame behind a `webRequest` event, or undefined when it is gone. */
function frameUrlOf(details: Electron.OnBeforeSendHeadersListenerDetails): string | undefined {
  try {
    return details.frame?.url
  } catch {
    // A frame disposed before the handshake throws on access: fail closed (no strip).
    return undefined
  }
}

/**
 * Remove `Origin` from the app document's hub sockets in `sess`. `appDocumentUrl` is
 * the renderer entry the app windows load: the packaged `file://…/index.html`, or the
 * dev server URL.
 */
export function attachHubSocketOriginStrip(
  sess: Pick<Session, 'webRequest'>,
  appDocumentUrl: string
): void {
  sess.webRequest.onBeforeSendHeaders({ urls: ['ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const strip = shouldStripHubSocketOrigin(
      { resourceType: details.resourceType, url: details.url, frameUrl: frameUrlOf(details) },
      appDocumentUrl
    )
    if (!strip) {
      callback({})
      return
    }
    const requestHeaders = { ...details.requestHeaders }
    for (const key of Object.keys(requestHeaders)) {
      if (key.toLowerCase() === 'origin') delete requestHeaders[key]
    }
    callback({ requestHeaders })
  })
}
