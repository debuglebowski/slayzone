/**
 * Host bridge URL derivation (slice 9 local cutover; cap+REST merged).
 *
 * When supervised by the Electron host, the host advertises ONE loopback
 * listener via `SLAYZONE_BRIDGE_URL` (`http://127.0.0.1:<port>`) carrying both:
 *  • the capability bridge on WS `/cap`, and
 *  • the Electron-only REST reverse-proxy on HTTP `/api/*`.
 *
 * The two consumers derive their scheme/path from that one base:
 *  • `getBridgeCapUrl()`  → `ws://127.0.0.1:<port>/cap` (host-bridge WS client).
 *  • `getBridgeRestUrl()` → `http://127.0.0.1:<port>` (REST reverse-proxy target).
 *
 * Truly standalone (no host): the env var is unset → both return null, so the
 * capability bridge stays null (fail-loud stubs) and the REST routes fall
 * through to express + 501.
 */

/** Raw host bridge base URL, or null when not supervised by an Electron host. */
export function getBridgeBaseUrl(): string | null {
  return process.env.SLAYZONE_BRIDGE_URL ?? null
}

/** WS URL for the capability bridge (`…/cap`), or null when standalone. */
export function getBridgeCapUrl(): string | null {
  const base = getBridgeBaseUrl()
  if (!base) return null
  const u = new URL(base)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/cap'
  return u.toString()
}

/** HTTP base URL for the Electron-only REST reverse-proxy, or null when standalone. */
export function getBridgeRestUrl(): string | null {
  return getBridgeBaseUrl()
}
