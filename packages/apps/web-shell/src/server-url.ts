// Web shell — server URL + windowId resolution.
//
// Unlike the Chromium fork (a separate native binary that pins a fixed
// loopback sidecar port, see window-api-shim/src/server-url.ts) this bundle
// is SERVED BY the hub it talks to (packages/apps/hub's static-asset
// dispatch — see server.ts's `handleWebAssets`). Same origin, same host,
// same port: no port-discovery channel is needed at all. `ws(s)` is derived
// from the page's own `location.protocol` so an `https://` deployment (the
// mandatory shape once a browser session is scoped, not `full` — see the web
// access plan's Phase 1) gets `wss://`, never a mixed-content `ws://`.
const trpcPath = '/trpc'

export function resolveServerUrl(): { mode: 'local' | 'remote'; url: string } {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return { mode: 'local', url: `${wsProtocol}//${window.location.host}${trpcPath}` }
}

// Multiple browser tabs can open the same hub concurrently. The server's
// per-connection contract keys warm-pool claims, panel ownership, and other
// per-window state on `ctx.windowId` (see routers that read it) — a constant
// (as the fork's single-window `CHROMIUM_WINDOW_ID` uses) would collide two
// tabs onto the same identity. `sessionStorage` is per-tab (unlike
// `localStorage`, which is shared across tabs of the same origin) and
// survives a same-tab reload, so a tab keeps its identity across navigation
// but never inherits another tab's.
const WINDOW_ID_KEY = 'slayzone-web-window-id'

export function resolveWindowId(): number {
  const stored = window.sessionStorage.getItem(WINDOW_ID_KEY)
  if (stored) {
    const parsed = Number(stored)
    if (Number.isFinite(parsed)) return parsed
  }
  // Random, not sequential — no server-side allocator to coordinate with, and
  // a per-tab id only needs to be distinct from other tabs' ids, not stable
  // across browser restarts.
  const fresh = Math.floor(Math.random() * 0x7fffffff) + 1
  window.sessionStorage.setItem(WINDOW_ID_KEY, String(fresh))
  return fresh
}
