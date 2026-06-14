// cap-shell-2 — public entry for @slayzone/window-api-shim.
//
// `setupWindowApi()` returns a populated ElectronAPI the shell installs on
// `window.api` before mounting React. Real wires use the four Mojo hosts
// TasksHost / ProjectsHost / TagsHost / SettingsHost; stub layers cover
// the 30 remaining namespaces so the renderer never throws on access.
// cap-shell-3..7 replace the stubs namespace-by-namespace.

import type { _LegacyElectronAPI as ElectronAPI } from '@slayzone/types'
import { buildApi } from './shims/index'
import { installTestInvoke } from './shims/test-invoke'

// cap-layout-p4 — native overlay control (LayoutHost.ShowOverlay) for the
// shell host to expose to the renderer (dialogs above the live embedded tab).
export { setNativeOverlay } from './transport/mojo'

export function setupWindowApi(): ElectronAPI {
  // cap-shell-16 — expose window.__testInvoke / __testEmit so Playwright
  // specs that came from the Electron suite route test channels to the
  // sidecar (or get an explicit "deferred" error for integrations:test:*).
  installTestInvoke()
  // cap-migrate-all-tests (sidecar-shim-unblocks P1 / Unblock #5) —
  // surface the sidecar's MCP server port as `window.__mcpPort` the same
  // way Electron main did. Fire-and-forget with a short backoff so the
  // binding works across the sidecar's async listen() call. 95-mcp-server's
  // `for i<20; __mcpPort check` loop polls up to 5s, which matches.
  void (async () => {
    const { jsonRpcCall } = await import('./transport/mojo')
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const res = await jsonRpcCall<{ port: number; ready: boolean }>('mcp:get-port', {})
        if (res?.ready && res.port > 0) {
          ;(globalThis as unknown as { __mcpPort?: number }).__mcpPort = res.port
          return
        }
      } catch {
        // transport not ready yet (hasMojo() false pre-mount) or sidecar not up
      }
      await new Promise((r) => setTimeout(r, 150))
    }
  })()
  return buildApi()
}
