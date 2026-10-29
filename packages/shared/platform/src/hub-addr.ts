/**
 * The hub-address grammar: parse, validate and compose hub addresses.
 *
 * AN ADDRESS IS ALWAYS `host[:port]` — no scheme, no path. Three env vars use it:
 *   - `SLAYZONE_HUB_LISTEN_ADDRESS`  the hub BINDS it       → {@link parseHubAddress}
 *   - `SLAYZONE_HUB_PUBLIC_ADDRESS`  how others reach the hub → {@link hubUrlFromAddr}
 *   - `SLAYZONE_HUB_ADDRESS`         computer / `slay` CONNECT to it → {@link hubUrlFromAddr}
 * The hub-side name used to be `SLAYZONE_HUB_ADDRESS` too; it was renamed so one
 * variable never means "where I listen" in one process and "where I dial" in
 * another. `sanitizeSpawnEnv` still strips all of them at every terminal-spawn
 * boundary.
 *
 * WHY NO SCHEME IN THE ENV CHANNEL: the dial-side consumers need different
 * schemes (the computer `ws(s)://…/computers`, the CLI `http(s)://…`), so a stored
 * scheme meant one of them was always reading the wrong shape — the retired
 * `SLAYZONE_HUB_URL` bug (a computer-hosted `slay` inheriting a `ws://` url and
 * hard-exiting). Every reader now DERIVES the scheme from the host itself
 * ({@link hubUrlFromAddr}, rule A1): a loopback host is plaintext (`http`/`ws`),
 * any other host is secure (`https`/`wss`) — the hub never terminates TLS, the
 * front end in front of a reachable hub does. That makes a scheme/reader mismatch
 * unrepresentable rather than merely unlikely, with no mode flag to forget.
 *
 * PORT GRAMMAR: a bare host means "port unspecified". Bind side → the hub walks
 * its port block (`port === undefined`); an explicit `:0` asks the OS for a free
 * port. Dial side → the scheme's default port stays implicit (the normal
 * published-DNS / reverse-proxy shape for a reachable hub).
 *
 * Lean leaf (node builtins only) so the computer bundle can import it via
 * `@slayzone/platform/hub-addr` WITHOUT the platform barrel.
 *
 * @module platform/hub-addr
 */

/**
 * Host literals that name THIS machine. Single source of truth for both readers
 * of a hub address that care: the bind side (warn when binding wider than
 * loopback) and the CLI (a non-loopback address must not be mistaken for the
 * local app's port). Matched against {@link HubBindAddress.host}, so IPv6 is
 * UNBRACKETED here.
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * True when a SOCKET PEER ADDRESS names this machine.
 *
 * Distinct from {@link LOOPBACK_HOSTS} on purpose, and the distinction is
 * load-bearing:
 *   - `LOOPBACK_HOSTS` matches a CONFIGURED HOST STRING — a value a human typed
 *     into `SLAYZONE_HUB_LISTEN_ADDRESS` or a config file — so it accepts `'localhost'`.
 *   - This matches `req.socket.remoteAddress`, which the kernel fills in. A
 *     socket address is an IP, never a hostname, so `'localhost'` here would only
 *     ever be a bug or a spoof attempt and is deliberately NOT accepted.
 *
 * Covers the three forms node reports: IPv6 loopback, the IPv4-mapped-IPv6 form,
 * and all of `127.0.0.0/8` (the whole block is loopback, not just `127.0.0.1`).
 *
 * Fails CLOSED: an absent or unparseable address is not loopback. Callers grant
 * access on a `true` here, so "unknown" must never mean "trusted".
 *
 * Consolidates three previously-duplicated copies (hub `rest-auth`, the
 * computers join-token route, and the hub users route), each of which had drifted
 * its own docstring while claiming to be the same predicate.
 */
export function isLoopbackPeer(addr: string | undefined | null): boolean {
  if (!addr) return false
  if (addr === '::1') return true
  // Node reports an IPv4 peer on a dual-stack socket as `::ffff:127.0.0.1`.
  const bare = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr
  return bare === '127.0.0.1' || bare.startsWith('127.')
}

/**
 * True when the HOST of an authority (`host` or `host:port`, no scheme) names this
 * machine — `127.0.0.1`, `localhost` or `::1` ({@link LOOPBACK_HOSTS}).
 *
 * Fails CLOSED: an unparseable authority is not loopback, so the scheme rule below
 * picks the secure scheme for it rather than plaintext.
 */
export function isLoopbackAuthority(addr: string): boolean {
  try {
    const host = new URL(`http://${addr}`).hostname.replace(/^\[|\]$/g, '')
    return LOOPBACK_HOSTS.has(host)
  } catch {
    return false
  }
}

/**
 * Build a hub URL from an authority (`host` or `host:port`, NO scheme, NO path).
 *
 * THE SCHEME RULE (A1), the same everywhere a hub is dialled — hub, computer and
 * `slay`: a loopback host (127.0.0.1, localhost, ::1) → `http` / `ws`; any other
 * host → `https` / `wss`. Nothing carries a scheme and nothing can disagree about
 * one.
 *
 * @param addr  the hub authority — `host[:port]`. Used verbatim; a host-only value
 *              keeps the scheme's default port implicit (the normal published-DNS /
 *              reverse proxy shape for a reachable hub).
 * @param kind  `'ws'` for the computer transport (ws/wss) or `'http'` for the CLI
 *              REST base (http/https).
 * @param path  optional path to append (e.g. `'/computers'`). Empty by default.
 * @returns     `<scheme>://<addr><path>`
 */
export function hubUrlFromAddr(addr: string, kind: 'ws' | 'http', path = ''): string {
  const secure = !isLoopbackAuthority(addr)
  const scheme = kind === 'ws' ? (secure ? 'wss' : 'ws') : secure ? 'https' : 'http'
  return `${scheme}://${addr}${path}`
}

/**
 * The hub authority (`host[:port]`) of a hub URL — the inverse of
 * {@link hubUrlFromAddr}, for handing a URL-shaped address down an env channel that
 * carries authority only.
 *
 * The answer must re-compose to the SAME endpoint, so a URL whose scheme is not the
 * one A1 derives from its host (e.g. `ws://hub.lan:8080`, which a reader would dial
 * as `https://hub.lan:8080`) yields null, as does anything that is not an http(s) or
 * ws(s) URL, or that carries userinfo. The path is dropped: an authority cannot
 * express one (same limit as {@link hubUrlFromAddr}). A port equal to the scheme's
 * default stays implicit, exactly as A1 composes it.
 */
export function hubAddrFromUrl(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(u.protocol)) return null
  const kind = u.protocol === 'ws:' || u.protocol === 'wss:' ? 'ws' : 'http'
  if (u.username !== '' || u.password !== '' || !isBareAuthority(u.host)) return null
  return new URL(hubUrlFromAddr(u.host, kind)).protocol === u.protocol ? u.host : null
}

/**
 * True when `addr` is a bare hub AUTHORITY — `host` or `host:port`, with NO
 * scheme (`://`), NO path (`/`), no userinfo and no whitespace.
 *
 * This is the env-channel guard: it is what keeps a scheme or a path from
 * sneaking into any hub address env var (`SLAYZONE_HUB_ADDRESS`, `_LISTEN_ADDRESS`,
 * `_PUBLIC_ADDRESS`) — carrying authority only is the entire point. Verifies by composing a throwaway URL
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

/**
 * True when a `ws(s)://…/computers` URL names THIS machine — so a join token
 * carrying it is only usable by a computer on the SAME box.
 *
 * WHY THIS EXISTS: a hub with no public address derives its computer URL as
 * `ws://<loopback>:<hubPort>/computers` (see the hub's `deriveComputerHubUrl`).
 * That is right for the co-located computer the desktop app
 * auto-enrolls, and useless for any other machine — an off-box computer handed such
 * a token dials its own loopback and silently never connects. Minting cannot
 * refuse (the loopback case is legitimate and common), so the surfaces that hand a
 * token to a human — the UI's mint dialog, `slay computer mint`, `slay computer
 * create` — use this to SAY so.
 *
 * Reuses {@link LOOPBACK_HOSTS}, the single source of truth for "names this
 * machine", so this predicate can never drift from the bind-side checks.
 *
 * A wildcard bind (`0.0.0.0` / `::`) is deliberately NOT loopback: such a token is
 * broken for every computer including a local one, so reporting it as a
 * same-machine URL would send the operator to the wrong fix.
 *
 * Returns false for anything unparseable — never claim loopback without knowing.
 */
export function isLoopbackComputerUrl(url: string): boolean {
  let host: string
  try {
    // `hostname` never carries the port, but DOES keep IPv6 brackets — strip them
    // to match LOOPBACK_HOSTS, which holds unbracketed literals (same convention
    // as parseHubAddress).
    host = new URL(url).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1 — a hub bound to
  // e.g. 127.0.0.53 is every bit as unreachable from another machine.
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.')
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

/**
 * Refuse to bind a supervised hub anywhere but loopback (rule B9).
 *
 * `SLAYZONE_SUPERVISED=1` means "the desktop app started me": no prompts, no
 * config file, and login off. That is only safe on this machine's loopback — the
 * flag is just an env var, so without this a stray one would expose a hub meant
 * for one user on a real interface. The desktop app already binds loopback; this
 * makes that non-regressible.
 */
export function assertLoopbackBind(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `[slayzone] SLAYZONE_SUPERVISED=1 marks a hub started by the desktop app, so it ` +
        `must listen on loopback — got '${host}'. Unset SLAYZONE_SUPERVISED for a hub ` +
        `that other machines should reach.`
    )
  }
}
