/**
 * Derive the computer-transport URL a minted join token carries.
 *
 * `/computers` no longer has its own listener/port — it rides the ONE hub listener
 * (`/trpc` + `/health` + `/mcp` + REST), demuxed by path (see server.ts). So there
 * is nothing to bind here; this module is a pure URL-deriver:
 *
 *   public address set → `<ws|wss>://<public-address>/computers`  (A2)
 *   otherwise          → `ws://<loopback>:<hubPort>/computers`
 *
 * The hub never terminates TLS: in front of a hub that other machines reach sits a
 * front end that does, and that front end is what the public address names. The
 * scheme follows the HOST (rule A1, `hubUrlFromAddr`): a loopback public address
 * (a same-box proxy under test) is `ws`, any other host is `wss`. The computer
 * learns proto/host/port from this URL when it comes from a join token; via the
 * env channel it gets AUTHORITY ONLY (`SLAYZONE_HUB_ADDRESS` = host[:port]) and
 * derives the same scheme with the same function, so the two can never disagree.
 *
 * The URL's port is the hub port itself (stable via claimServerPort /
 * SIDECAR_FIXED_PORT), so the computer credential key (hubHostFromUrl → host_port)
 * stays stable across reboots WITHOUT the old dedicated computer-port persistence.
 *
 * @module server/computer-listener
 */

import { hubUrlFromAddr, isBareAuthority } from '@slayzone/platform/hub-addr'

/** A loopback bind host is not dialable as-is only when it is the wildcard; a
 *  real loopback literal (127.0.0.1/::1/localhost) goes into the token verbatim. */
function dialableLoopback(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
}

export interface DeriveComputerHubUrlOptions {
  /** The hub's bind host (used as the `ws://` host when there is no public address). */
  host: string
  /** The actually-bound hub port (shared with `/trpc`). */
  port: number
  /**
   * SLAYZONE_HUB_PUBLIC_ADDRESS — how OTHER machines reach the hub (`host[:port]`,
   * no scheme, no path). Needed alongside the bind host/port because a proxied /
   * NAT'd hub binds one address and is reached at another. Required whenever the
   * hub is reachable off-box (boot rule B3), so an unset value here means a hub
   * only this machine can reach.
   */
  publicAddress?: string
}

/**
 * Build the `ws(s)://…/computers` URL to embed in join tokens.
 *
 * - public address set: `<scheme>://<public-address>/computers`. Returns null for a
 *   malformed address (boot rule B8 refuses one, so this is defensive): the caller
 *   then leaves computer enroll unavailable rather than embedding a broken target
 *   in a token. A bare host keeps the default TLS port implicit (443) — the normal
 *   reverse-proxy / published-DNS shape.
 * - otherwise: `ws://<loopback>:<port>/computers`.
 */
export function deriveComputerHubUrl(opts: DeriveComputerHubUrlOptions): string | null {
  const raw = opts.publicAddress?.trim()
  if (raw === undefined || raw === '') {
    return `ws://${dialableLoopback(opts.host)}:${opts.port}/computers`
  }
  if (!isBareAuthority(raw)) return null
  return hubUrlFromAddr(raw, 'ws', '/computers')
}
