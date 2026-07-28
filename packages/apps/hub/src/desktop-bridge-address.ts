/**
 * Desktop bridge address derivation (slice 9 local cutover; cap+REST merged).
 *
 * When supervised by the Electron desktop app, the desktop advertises ONE
 * loopback listener via `SLAYZONE_DESKTOP_BRIDGE_ADDRESS` (`127.0.0.1:<port>`)
 * carrying both:
 *  • the capability bridge on WS `/cap`, and
 *  • the Electron-only REST reverse-proxy on HTTP `/api/*`.
 *
 * Authority-only, no scheme (env-var naming rule 5): the bridge exists ONLY when
 * the desktop supervises us, which is always a loopback listener, so the scheme
 * is unconditionally `ws`/`http` — a scheme/reader mismatch is unrepresentable.
 *
 * The two consumers derive scheme + path from that one authority:
 *  • `getDesktopBridgeCapUrl()`  → `ws://127.0.0.1:<port>/cap` (bridge WS client).
 *  • `getDesktopBridgeRestUrl()` → `http://127.0.0.1:<port>` (reverse-proxy target).
 *
 * Truly standalone (no desktop): the env var is unset → both return null, so the
 * capability bridge stays null (fail-loud stubs) and the REST routes fall
 * through to express + 501.
 */

/** Raw bridge authority (`host:port`), or null when the desktop app isn't supervising. */
export function getDesktopBridgeAddress(): string | null {
  return process.env.SLAYZONE_DESKTOP_BRIDGE_ADDRESS?.trim() || null
}

/** WS URL for the capability bridge (`…/cap`), or null when standalone. */
export function getDesktopBridgeCapUrl(): string | null {
  const address = getDesktopBridgeAddress()
  return address ? `ws://${address}/cap` : null
}

/** HTTP base URL for the Electron-only REST reverse-proxy, or null when standalone. */
export function getDesktopBridgeRestUrl(): string | null {
  const address = getDesktopBridgeAddress()
  return address ? `http://${address}` : null
}
