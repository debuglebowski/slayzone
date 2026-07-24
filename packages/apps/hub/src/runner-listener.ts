/**
 * Derive the runner-transport URL advertised in a minted join token.
 *
 * `/runners` no longer has its own listener/port — it rides the ONE hub listener
 * (`/trpc` + `/health` + `/mcp` + REST), demuxed by path (see server.ts). So there
 * is nothing to bind here; this module is now a pure URL-deriver:
 *
 *   local  → `ws://<loopback>:<hubPort>/runners`  (dev / e2e / supervised)
 *   remote → `wss://<public-host>/runners`         (from SLAYZONE_HUB_PUBLIC_URL)
 *
 * The runner learns proto/host/port ENTIRELY from this URL (join token or
 * SLAYZONE_HUB_URL) — the scheme is what gates its TLS + cert-pin path
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

/** A loopback bind host is not dialable as-is only when it is the wildcard; a
 *  real loopback literal (127.0.0.1/::1/localhost) is advertised verbatim. */
function dialableLoopback(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
}

export interface DeriveRunnerHubUrlOptions {
  /** True in SLAYZONE_MODE=remote — advertise `wss://` from the public URL. */
  remote: boolean
  /** The hub's bind host (used for the local `ws://` advertise host). */
  host: string
  /** The actually-bound hub port (shared with `/trpc`). */
  port: number
  /** SLAYZONE_HUB_PUBLIC_URL — the hub's external address, REQUIRED in remote. */
  publicUrl?: string
}

/**
 * Build the `ws(s)://…/runners` URL to embed in join tokens.
 *
 * - remote: derive `wss://<host[:port]>/runners` from SLAYZONE_HUB_PUBLIC_URL
 *   (http/https/ws/wss all accepted; scheme forced to wss, path forced to
 *   `/runners`). Returns null for a missing/malformed public URL — the caller
 *   then leaves runner enroll unavailable rather than advertising a broken target.
 * - local: `ws://<loopback>:<port>/runners`.
 */
export function deriveRunnerHubUrl(opts: DeriveRunnerHubUrlOptions): string | null {
  if (!opts.remote) {
    return `ws://${dialableLoopback(opts.host)}:${opts.port}/runners`
  }
  const raw = opts.publicUrl?.trim()
  if (!raw) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return null
  // `host` carries the port when the public URL specifies one; a bare host keeps
  // the hub's default TLS port implicit (443), which is the normal reverse-proxy /
  // published-DNS shape for a remote hub.
  return `wss://${parsed.host}/runners`
}
