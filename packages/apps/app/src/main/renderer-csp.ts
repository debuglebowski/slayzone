/**
 * Content-Security-Policy for the app renderer.
 *
 * The renderer's only dynamic connection target is the in-process tRPC
 * WebSocket server, which binds an OS-assigned port (see ws-server.ts). A
 * static policy cannot name that port, so the CSP is layered:
 *
 *   1. A wildcard-port floor (`RENDERER_CSP_FLOOR`) is injected into the HTML
 *      as a `<meta>` tag at build time (see electron.vite.config.ts). This
 *      guarantees the document always has a CSP, even if the header below
 *      never lands (e.g. a `file://` load that skips webRequest).
 *   2. An exact-port header (`buildRendererCsp`) is emitted at runtime via
 *      `session.webRequest.onHeadersReceived`. When both are present the
 *      browser enforces their intersection — so the effective `connect-src`
 *      is the exact port, and the floor only governs if the header is absent.
 *
 * This module is the single source of truth for both layers, and is kept free
 * of runtime imports so the build config can import it.
 */

/** Directives that never depend on runtime state. */
const STATIC_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self' slz-file:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: slz-file:"
]

/** Fixed remote origins the renderer talks to (PostHog, Convex, GitHub). */
const REMOTE_CONNECT_SRC = [
  'https://*.posthog.com',
  'https://*.i.posthog.com',
  'https://*.convex.cloud',
  'wss://*.convex.cloud',
  'https://*.convex.site',
  'wss://*.convex.site',
  'https://api.github.com'
]

/** Assembles a full policy string from the connection target for the tRPC WS. */
function assembleCsp(trpcConnectSrc: string): string {
  const connectSrc = ['connect-src', "'self'", trpcConnectSrc, ...REMOTE_CONNECT_SRC]
    .filter(Boolean)
    .join(' ')
  return [...STATIC_DIRECTIVES, connectSrc].join('; ')
}

/**
 * The build-time floor: a complete policy whose `connect-src` allows the tRPC
 * WS on any loopback port. Injected as a `<meta>` tag so the document is never
 * left without a CSP; the runtime header narrows the port to an exact match.
 */
export const RENDERER_CSP_FLOOR = assembleCsp('ws://127.0.0.1:*')

/**
 * Builds the runtime CSP string with the tRPC WS port named exactly. When
 * `trpcPort` is unknown (0/undefined) the origin is omitted — the policy still
 * applies, tRPC just stays blocked until a port is known (the renderer defers
 * its WS connect on the same signal).
 */
export function buildRendererCsp(trpcPort: number | undefined): string {
  return assembleCsp(trpcPort && trpcPort > 0 ? `ws://127.0.0.1:${trpcPort}` : '')
}

/**
 * Attaches the runtime CSP header to a session. Every top-level document
 * (`mainFrame`) response gets a freshly built `Content-Security-Policy`
 * header with the current tRPC port; sub-resources pass through untouched
 * (CSP is enforced from the document response only).
 *
 * `getTrpcPort` resolves the port once the in-process server is listening; it
 * is awaited per document load so the very first window — which may load
 * before the server binds — still gets the exact port.
 */
export function attachRendererCsp(
  sess: Electron.Session,
  getTrpcPort: () => Promise<number>
): void {
  sess.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame') {
      callback({})
      return
    }
    void getTrpcPort().then((port) => {
      const headers: Record<string, string[] | string> = { ...details.responseHeaders }
      // Drop any pre-existing CSP header (case-insensitive) before setting ours.
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'content-security-policy') delete headers[key]
      }
      headers['Content-Security-Policy'] = [buildRendererCsp(port)]
      callback({ responseHeaders: headers })
    })
  })
}
