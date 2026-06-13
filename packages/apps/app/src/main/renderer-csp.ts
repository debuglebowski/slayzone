/**
 * Content-Security-Policy for the app renderer.
 *
 * The renderer's only dynamic connection target is the tRPC WebSocket server
 * — local mode binds an OS-assigned loopback port (see ws-server.ts), remote
 * mode (slice 7) targets a user-configured ws(s) host. A static policy cannot
 * name either, so the CSP is layered:
 *
 *   1. A scheme-wide floor (`buildCspFloor`) is injected into the HTML
 *      as a `<meta>` tag at build time (see electron.vite.config.ts). This
 *      guarantees the document always has a CSP, even if the header below
 *      never lands (e.g. a `file://` load that skips webRequest).
 *   2. An exact-origin header (`buildRendererCsp`) is emitted at runtime via
 *      `session.webRequest.onHeadersReceived`. When both are present the
 *      browser enforces their intersection — so the effective `connect-src`
 *      is the exact tRPC origin, and the floor only governs if the header is
 *      absent.
 *
 * This module is the single source of truth for both layers, and is kept free
 * of runtime imports so the build config can import it.
 */

/**
 * Directives that never depend on the runtime tRPC port.
 *
 * `dev` relaxes `script-src`: Vite's dev server injects the React Fast Refresh
 * preamble as an *inline* `<script type="module">`, which a bare `script-src
 * 'self'` blocks — leaving `$RefreshSig$`/`$RefreshReg$` undefined and crashing
 * the first refresh-transformed module to evaluate. Prod is fully bundled with
 * no inline scripts, so it keeps the strict `'self'`.
 */
function staticDirectives(dev: boolean): string[] {
  return [
    "default-src 'self'",
    dev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'",
    "worker-src 'self' blob:",
    "frame-src 'self' slz-file:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https: slz-file:"
  ]
}

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
function assembleCsp(trpcConnectSrc: string, dev: boolean): string {
  const connectSrc = ['connect-src', "'self'", trpcConnectSrc, ...REMOTE_CONNECT_SRC]
    .filter(Boolean)
    .join(' ')
  return [...staticDirectives(dev), connectSrc].join('; ')
}

/**
 * The build-time floor: a complete policy whose `connect-src` allows the tRPC
 * WS. The floor can't name the exact origin — the local OS-assigned port and a
 * remote host are both unknowable at build time — but it is deliberately NOT
 * `ws: wss:` (which would permit arbitrary plaintext-ws exfil to any host in
 * the rare case the runtime header is absent). Instead:
 *   - `ws://127.0.0.1:*` — local mode: loopback, any port (as tight as before).
 *   - `wss:` — remote mode: any host, but TLS-only.
 * A plaintext-`ws://` remote (e.g. a LAN box without TLS) is therefore allowed
 * only via the exact runtime header below, not the floor fallback. Injected as
 * a `<meta>` tag so the document is never left without a CSP.
 *
 * `dev` must match the build mode — the meta floor and the runtime header are
 * enforced as an intersection, so both layers need the dev `script-src`
 * relaxation or the stricter one still blocks Vite's inline preamble.
 */
export function buildCspFloor(dev: boolean): string {
  return assembleCsp('ws://127.0.0.1:* wss:', dev)
}

/**
 * Builds the runtime CSP string with the tRPC WS origin named exactly —
 * `ws://127.0.0.1:<port>` in local mode, the configured ws(s) origin in
 * remote mode. When the origin is unknown (server not bound yet) it is
 * omitted — the policy still applies, tRPC just stays blocked until an origin
 * is known (the renderer defers its WS connect on the same signal).
 */
export function buildRendererCsp(trpcOrigin: string, dev: boolean): string {
  return assembleCsp(trpcOrigin, dev)
}

/**
 * Attaches the runtime CSP header to a session. Every top-level document
 * (`mainFrame`) response gets a freshly built `Content-Security-Policy`
 * header with the current tRPC origin; sub-resources pass through untouched
 * (CSP is enforced from the document response only).
 *
 * `getTrpcOrigin` resolves the exact origin — local: once the in-process
 * server is listening (awaited per document load so the very first window,
 * which may load before the server binds, still gets the exact origin);
 * remote: the configured host. Resolving '' omits the origin.
 */
export function attachRendererCsp(
  sess: Electron.Session,
  getTrpcOrigin: () => Promise<string>,
  dev: boolean
): void {
  sess.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame') {
      callback({})
      return
    }
    void getTrpcOrigin().then((origin) => {
      const headers: Record<string, string[] | string> = { ...details.responseHeaders }
      // Drop any pre-existing CSP header (case-insensitive) before setting ours.
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'content-security-policy') delete headers[key]
      }
      headers['Content-Security-Policy'] = [buildRendererCsp(origin, dev)]
      callback({ responseHeaders: headers })
    })
  })
}
