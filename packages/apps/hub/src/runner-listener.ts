/**
 * Derive the runner-transport URL a minted join token carries.
 *
 * `/runners` no longer has its own listener/port — it rides the ONE hub listener
 * (`/trpc` + `/health` + `/mcp` + REST), demuxed by path (see server.ts). So there
 * is nothing to bind here; this module is now a pure URL-deriver:
 *
 *   local  → `ws://<loopback>:<hubPort>/runners`  (dev / e2e / supervised)
 *   remote → `wss://<public-address>/runners`      (from SLAYZONE_HUB_PUBLIC_ADDRESS)
 *
 * The runner learns proto/host/port from this URL when it comes from a join token;
 * via the env channel it gets AUTHORITY ONLY (`SLAYZONE_HUB_ADDRESS` = host[:port])
 * and derives the scheme from SLAYZONE_MODE itself — the scheme gates its TLS + cert-pin path
 * (hub-dialer: `ws:` = no pin, `wss:` = pin the leaf). In remote the single hub
 * listener terminates TLS with the hub identity leaf, so the fingerprint the token
 * carries is enforced end-to-end, unchanged from the old separate-listener design.
 *
 * The URL's port is the hub port itself (stable via claimServerPort /
 * SIDECAR_FIXED_PORT), so the runner credential key (hubHostFromUrl → host_port)
 * stays stable across reboots WITHOUT the old dedicated runner-port persistence.
 *
 * @module server/runner-listener
 */

import { hubUrlFromAddr, isBareAuthority } from '@slayzone/platform/hub-addr'

/** A loopback bind host is not dialable as-is only when it is the wildcard; a
 *  real loopback literal (127.0.0.1/::1/localhost) goes into the token verbatim. */
function dialableLoopback(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
}

export interface DeriveRunnerHubUrlOptions {
  /** True in SLAYZONE_MODE=remote — derive `wss://` from the public address. */
  remote: boolean
  /** The hub's bind host (used as the local `ws://` host). */
  host: string
  /** The actually-bound hub port (shared with `/trpc`). */
  port: number
  /**
   * SLAYZONE_HUB_PUBLIC_ADDRESS — the hub's EXTERNAL address (`host[:port]`, no
   * scheme, no path), REQUIRED in remote. Needed alongside the bind host/port
   * because a proxied / NAT'd hub binds one address and is reached at another.
   */
  publicAddress?: string
}

/**
 * Build the `ws(s)://…/runners` URL to embed in join tokens.
 *
 * - remote: `wss://<public-address>/runners` from SLAYZONE_HUB_PUBLIC_ADDRESS.
 *   The value is authority ONLY, so there is no scheme to disagree about — `wss`
 *   is implied by remote mode. Returns null for a missing/malformed address; the
 *   caller then leaves runner enroll unavailable rather than embedding a broken
 *   target in a token.
 * - local: `ws://<loopback>:<port>/runners`.
 */
export function deriveRunnerHubUrl(opts: DeriveRunnerHubUrlOptions): string | null {
  if (!opts.remote) {
    return `ws://${dialableLoopback(opts.host)}:${opts.port}/runners`
  }
  const raw = opts.publicAddress?.trim()
  // A bare host keeps the default TLS port implicit (443) — the normal
  // reverse-proxy / published-DNS shape for a remote hub.
  if (!raw || !isBareAuthority(raw)) return null
  return hubUrlFromAddr(raw, 'ws', '/runners', 'remote')
}
