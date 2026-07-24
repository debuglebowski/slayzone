// cap-shell — sidecar tRPC server URL resolution for the Chromium fork.
//
// The renderer connects to the standalone @slayzone/hub over a tRPC
// WebSocket (server-mode). Unlike Electron — which discovers a dynamic port via
// the preload's app.getServerUrl() — the fork pins the sidecar to a fixed
// loopback port (see scripts/chromium/run.sh: SLAYZONE_HUB_PORT) so the renderer can
// resolve the URL without any host→renderer port-discovery channel.
//
// Resolution order:
//   1. window.__slayzoneServerUrl — optional runtime override. Reserved for a
//      future C++ launch flag (--slayzone-server-url) that the shell would read
//      and assign before the renderer module graph evaluates. Unset today.
//   2. Build-time default selected by __SLAYZONE_CHROMIUM_PROD__ (chromium-shell
//      vite define): dev :8766 vs prod :8765. Dev/prod ports differ so a dev
//      build and a packaged app can run side-by-side without colliding.

declare const __SLAYZONE_CHROMIUM_PROD__: boolean

// Host is `localhost` (not 127.0.0.1) to satisfy the shell WebUI CSP, whose
// connect-src allowlists `ws://localhost:*` (dev-server mode today; loopback ws
// in prod after the slayzone_shell_ui.cc CSP change). Chrome resolves localhost
// to the loopback the sidecar binds (127.0.0.1).
const DEV_SERVER_URL = 'ws://localhost:8766/trpc'
const PROD_SERVER_URL = 'ws://localhost:8765/trpc'

// Single-window fork: the tRPC WS server tags each connection with a windowId
// (Electron has many windows). One window here → a constant is sufficient.
export const CHROMIUM_WINDOW_ID = 1

export function resolveServerUrl(): { mode: 'local' | 'remote'; url: string } {
  const override = (globalThis as { __slayzoneServerUrl?: unknown }).__slayzoneServerUrl
  if (typeof override === 'string' && override.length > 0) {
    return { mode: 'local', url: override }
  }
  const isProd = typeof __SLAYZONE_CHROMIUM_PROD__ !== 'undefined' && __SLAYZONE_CHROMIUM_PROD__
  return { mode: 'local', url: isProd ? PROD_SERVER_URL : DEV_SERVER_URL }
}
