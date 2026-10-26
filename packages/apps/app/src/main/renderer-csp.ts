/**
 * Content-Security-Policy for the app renderer.
 *
 * The renderer's only dynamic connection targets are hub tRPC WebSockets —
 * the local sidecar on an OS-assigned loopback port, plus every user-registered
 * remote ws(s) hub (multi-hub federation). A static policy cannot name these,
 * so the CSP is layered:
 *
 *   1. A scheme-wide floor (`buildCspFloor`) is injected into the HTML
 *      as a `<meta>` tag at build time (see electron.vite.config.ts). This
 *      guarantees the document always has a CSP, even if the header below
 *      never lands (e.g. a `file://` load that skips webRequest).
 *   2. An exact-origin header (`buildRendererCsp`) is emitted at runtime via
 *      `session.webRequest.onHeadersReceived`. When both are present the
 *      browser enforces their intersection — so the effective `connect-src`
 *      is the exact hub origins, and the floor only governs if the header is
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
 * the rare case the runtime header is absent). Instead it mirrors the hub
 * scheme rule (`hubUrlFromAddr`: loopback → ws, any other host → wss):
 *   - `ws://127.0.0.1:*`, `ws://localhost:*` — loopback hubs, any port.
 *     (`::1` is omitted: CSP host-sources can't name an IPv6 literal.)
 *   - `wss:` — remote hubs: any host, but TLS-only.
 * The floor and the runtime header are INTERSECTED, so a plaintext `ws://`
 * hub on a non-loopback host (e.g. a LAN box without TLS) is blocked even when
 * the header names it — consistent with the scheme rule. Injected as a
 * `<meta>` tag so the document is never left without a CSP.
 *
 * `dev` must match the build mode — the meta floor and the runtime header are
 * enforced as an intersection, so both layers need the dev `script-src`
 * relaxation or the stricter one still blocks Vite's inline preamble.
 */
export function buildCspFloor(dev: boolean): string {
  return assembleCsp('ws://127.0.0.1:* ws://localhost:* wss:', dev)
}

/**
 * The `connect-src` entries for every hub the renderer may dial (#161). With
 * multi-hub federation the renderer opens one tRPC WS per registered hub, so a
 * single boot-time origin is not enough:
 *   - the co-located local hub → `ws://127.0.0.1:*` (its sidecar port can change
 *     across respawns; loopback-only, so the port wildcard is safe);
 *   - each registered remote hub → its exact ws(s) origin, plus the matching
 *     http(s) origin of the same host (already trusted by the user; keeps a
 *     future renderer-side HTTP call to the hub from silently breaking).
 * Malformed or non-ws(s) urls are dropped, so a bad registry row can never
 * widen the policy. Exact origins only — never a scheme or host wildcard.
 */
export function hubConnectSources(hubs: {
  localHub: boolean
  remoteHubUrls: readonly string[]
}): string {
  const sources = new Set<string>()
  if (hubs.localHub) sources.add('ws://127.0.0.1:*')
  for (const raw of hubs.remoteHubUrls) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') continue
    sources.add(url.origin)
    sources.add(`${url.protocol === 'wss:' ? 'https' : 'http'}://${url.host}`)
  }
  return [...sources].join(' ')
}

/**
 * Builds the runtime CSP string with the tRPC connect sources named exactly
 * (see `hubConnectSources`). When none are known they are omitted — the policy
 * still applies, tRPC just stays blocked.
 */
export function buildRendererCsp(trpcConnectSrc: string, dev: boolean): string {
  return assembleCsp(trpcConnectSrc, dev)
}

/**
 * Attaches the runtime CSP header to a session. Every top-level document
 * (`mainFrame`) response gets a freshly built `Content-Security-Policy`
 * header with the current tRPC origin; sub-resources pass through untouched
 * (CSP is enforced from the document response only).
 *
 * `getTrpcOrigin` resolves the connect sources per document load (see
 * `hubConnectSources`). Resolving '' omits them.
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
