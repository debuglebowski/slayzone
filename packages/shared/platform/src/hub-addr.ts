/**
 * The hub-address grammar: parse, validate and compose `SLAYZONE_HUB_ADDRESS`.
 *
 * ONE CONCEPT, TWO ROLES. `SLAYZONE_HUB_ADDRESS` means "the hub's address" —
 * `host[:port]`, no scheme, no path. Its VALUE differs by which app holds it:
 *   - the hub        BINDS it       → {@link parseHubAddress} (host + port)
 *   - runner / `slay` CONNECT to it → {@link hubUrlFromAddr} (full URL)
 * Different processes holding different values under one name is intended, not a
 * collision: `sanitizeSpawnEnv` strips the var at every terminal-spawn boundary,
 * so a value can never bleed from one role into the other.
 *
 * WHY NO SCHEME IN THE ENV CHANNEL: the two dial-side consumers need different
 * schemes (the runner `ws(s)://…/runners`, the CLI `http(s)://…`), so a stored
 * scheme meant one of them was always reading the wrong shape — the retired
 * `SLAYZONE_HUB_URL` bug (a runner-hosted `slay` inheriting a `ws://` url and
 * hard-exiting). Both now DERIVE the scheme from the single `SLAYZONE_MODE`
 * lever, which makes the mismatch unrepresentable rather than merely unlikely.
 *
 * PORT GRAMMAR: a bare host means "port unspecified". Bind side → the OS assigns
 * a free port (`port === undefined`, callers default to 0); an explicit `:0` says
 * the same outright. Dial side → the scheme's default port stays implicit (the
 * normal published-DNS / reverse-proxy shape for a remote hub).
 *
 * Lean leaf (only ./slayzone-mode + node builtins) so the runner bundle can
 * import it via `@slayzone/platform/hub-addr` WITHOUT the platform barrel.
 *
 * @module platform/hub-addr
 */

import { getSlayzoneMode, type SlayzoneMode } from './slayzone-mode'

// Re-exported so a consumer importing this lean subpath can name the mode type
// without also depending on a separate slayzone-mode subpath export.
export type { SlayzoneMode } from './slayzone-mode'

/**
 * Host literals that name THIS machine. Single source of truth for both readers
 * of a hub address that care: the bind side (warn when binding wider than
 * loopback) and the CLI (a non-loopback address must not be mistaken for the
 * local app's port). Matched against {@link HubBindAddress.host}, so IPv6 is
 * UNBRACKETED here.
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * Build a hub URL from an authority (`host` or `host:port`, NO scheme, NO path).
 *
 * @param addr  the hub authority — `host[:port]`, exactly as carried in
 *              `SLAYZONE_HUB_ADDRESS`. Used verbatim; a host-only value keeps the
 *              scheme's default port implicit (the normal published-DNS / reverse
 *              proxy shape for a remote hub).
 * @param kind  `'ws'` for the runner transport (ws/wss) or `'http'` for the CLI
 *              REST base (http/https).
 * @param path  optional path to append (e.g. `'/runners'`). Empty by default.
 * @param mode  the deployment mode. Defaults to `getSlayzoneMode()` (reads
 *              `process.env`); pass an explicit mode to stay hermetic under a
 *              test that supplies its own env (e.g. `loadRunnerConfig(customEnv)`).
 * @returns     `<scheme>://<addr><path>`, where scheme is secure (`wss`/`https`)
 *              in `remote` mode and plaintext (`ws`/`http`) otherwise.
 */
export function hubUrlFromAddr(
  addr: string,
  kind: 'ws' | 'http',
  path = '',
  mode: SlayzoneMode = getSlayzoneMode()
): string {
  const secure = mode === 'remote'
  const scheme = kind === 'ws' ? (secure ? 'wss' : 'ws') : secure ? 'https' : 'http'
  return `${scheme}://${addr}${path}`
}

/**
 * True when `addr` is a bare hub AUTHORITY — `host` or `host:port`, with NO
 * scheme (`://`), NO path (`/`), no userinfo and no whitespace.
 *
 * This is the env-channel guard: it is what keeps a scheme or a path from
 * sneaking into `SLAYZONE_HUB_ADDRESS` / `SLAYZONE_HUB_PUBLIC_ADDRESS` (carrying
 * authority only is the entire point). Verifies by composing a throwaway URL
 * whose `host` must round-trip back to the input — which also rejects embedded
 * userinfo and stray characters, and (unlike a plain URL parse) catches a
 * double-scheme like `http://http://x`.
 *
 * IPv6 must be given in URL-authority form (bracketed): `[::1]` / `[::1]:8080`.
 */
export function isBareAuthority(addr: string): boolean {
  if (addr === '' || /[/\s]/.test(addr) || addr.includes('://')) return false
  try {
    const u = new URL(`http://${addr}`)
    // `host` preserves an explicit port; everything else must be empty.
    return (
      u.host === addr &&
      u.pathname === '/' &&
      u.search === '' &&
      u.hash === '' &&
      u.username === '' &&
      u.password === ''
    )
  } catch {
    return false
  }
}

/** A hub address split for the BIND side. `port === undefined` = OS-assigned. */
export interface HubBindAddress {
  /** Bare host literal, IPv6 UNBRACKETED (what `server.listen(host)` wants). */
  host: string
  /** Explicit port, or undefined when the address named no port. `0` = OS-assigned. */
  port: number | undefined
}

/**
 * Parse a hub address into `{host, port}` for the BIND side (the hub itself).
 *
 * Returns null for anything that is not a bare authority with a valid port, so a
 * caller falls back to its own default rather than binding something the operator
 * never asked for. IPv6 comes back UNBRACKETED: node's `listen(host)` wants the
 * bare literal, while the URL authority form requires the brackets.
 *
 * @param addr the raw env value (surrounding whitespace is trimmed); `undefined`
 *             or empty resolves to null.
 */
export function parseHubAddress(addr: string | undefined): HubBindAddress | null {
  const trimmed = addr?.trim()
  if (!trimmed || !isBareAuthority(trimmed)) return null
  const u = new URL(`http://${trimmed}`)
  // `u.port` is '' when the authority named no port → OS-assigned. The URL parser
  // already rejected an out-of-range or non-numeric port (isBareAuthority's
  // round-trip fails, since `host` would not match the input).
  const port = u.port === '' ? undefined : Number(u.port)
  // hostname drops IPv6 brackets; unlike `host` it never carries the port.
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port }
}
