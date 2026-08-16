/**
 * Origin guard for the `/trpc` WebSocket upgrade.
 *
 * WHY THIS EXISTS: `/trpc` exposes the ENTIRE app router — pty spawn, browser
 * eval, `shell.openExternal`, file ops, the auth-callback relay. A drive-by web
 * page, or a DNS rebind that resolves an attacker hostname to 127.0.0.1, must not
 * be able to open that socket from a victim's browser.
 *
 * WHY IT IS ITS OWN MODULE: this used to be a closure inside `startServer`, which
 * made it the one security decision in the hub with NO unit test — you cannot
 * reach it without booting two listeners. `rest-auth.ts` and `hub-trpc-context.ts`
 * both call out in their docstrings that they were extracted as pure functions
 * precisely so the decision is testable. This is the third.
 *
 * WHAT IT IS NOT: this is defense in depth, not the auth boundary. A non-browser
 * client sends no `Origin` at all and is admitted here, then gated by
 * `restAuthAction` / the tRPC auth gate like everything else. The guard's job is
 * to stop a BROWSER being turned into a confused deputy, which is a threat only
 * browsers can pose because only browsers attach ambient credentials.
 *
 * @module hub/ws-origin
 */

/** Origins that only ever belong to a local, first-party client. */
const LOCAL_CLIENT_PROTOCOLS = new Set(['chrome:', 'chrome-extension:', 'devtools:', 'file:'])

/**
 * Hostnames that name this machine, as `URL.hostname` reports them.
 *
 * The IPv6 literal is BRACKETED here — WHATWG `URL` keeps the brackets
 * (`new URL('http://[::1]:8765').hostname === '[::1]'`). The pre-extraction
 * implementation compared against a bare `'::1'`, which therefore never matched
 * any real origin; the bare form is kept alongside so neither spelling depends on
 * that detail being remembered.
 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export type WsOriginDecision = 'accept' | 'reject'

export interface WsOriginOptions {
  /** The `Origin` header, if the client sent one. */
  origin: string | undefined
  /**
   * Whether the Electron host owns this hub. Supervised hubs are loopback-bound
   * by assertion and serve renderers at `file://` / `chrome://` / `null`.
   */
  supervised: boolean
  /**
   * Whether this hub binds a loopback address. A loopback-bound standalone hub is
   * the normal dev shape (the Chromium fork's backend, `pnpm dev`, the web dev
   * server) and its clients legitimately live at `http://localhost:<port>`.
   */
  loopbackBind: boolean
  /**
   * Exact origins this hub additionally accepts, e.g. the public origin a
   * browser-served web UI runs at. Compared as full origin strings.
   */
  allowedOrigins?: readonly string[]
}

/**
 * Decide whether to accept a `/trpc` WebSocket upgrade.
 *
 * Three admissions, each narrower than the blanket one it replaced:
 *
 *  1. **No `Origin` header → accept.** Browsers ALWAYS send `Origin` on a WS
 *     handshake, so its absence means the caller is not a browser: Electron main,
 *     node tooling, e2e, the sidecar, `slay`. Those cannot be confused deputies —
 *     they carry no ambient credentials for an attacker to borrow — and they are
 *     still bearer-gated afterwards. Accepting them here is what keeps every
 *     native client working on an enforcing hub.
 *
 *  2. **Local-client origins → accept only when the hub is local.** `file:`,
 *     `chrome:`, `chrome-extension:`, `devtools:` and `null` are first-party
 *     renderer origins. `null` is the dangerous one: `file://` serializes to it,
 *     but SO DOES ANY SANDBOXED IFRAME — `<iframe sandbox>` without
 *     `allow-same-origin` — which any website on the internet can embed. Blanket-
 *     accepting `null` therefore meant "accept every website" on an internet-facing
 *     hub. Gating these on `supervised || loopbackBind` keeps the fork, the
 *     packaged app and dev loops working while closing that door for a hub anyone
 *     can reach.
 *
 *  3. **`localhost` origins → accept only when the hub binds loopback**, and
 *     `allowedOrigins` entries always. Note the comparison is on the FULL origin
 *     (scheme + host + port) for `allowedOrigins`; the previous implementation
 *     compared `hostname` alone, so `http://localhost:<any port>` was accepted and
 *     a hostile local dev server could open the socket.
 *
 * Unparseable input is rejected — fail closed.
 */
export function wsOriginDecision(opts: WsOriginOptions): WsOriginDecision {
  const { origin, supervised, loopbackBind } = opts
  const local = supervised || loopbackBind

  // (1) Non-browser client.
  if (!origin) return 'accept'

  // An explicitly allowed origin wins regardless of shape — this is how a
  // browser-served web UI reaches its own hub. Exact string match, so a
  // lookalike host (`https://hub.example.com.evil.test`) cannot suffix its way in.
  if (opts.allowedOrigins?.includes(origin)) return 'accept'

  // (2) Opaque origin. `file://` AND every sandboxed iframe on the web.
  if (origin === 'null') return local ? 'accept' : 'reject'

  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return 'reject'
  }

  if (LOCAL_CLIENT_PROTOCOLS.has(u.protocol)) return local ? 'accept' : 'reject'

  // (3) Loopback web origin.
  if (LOCAL_HOSTNAMES.has(u.hostname)) return loopbackBind ? 'accept' : 'reject'

  return 'reject'
}

/**
 * The exact origins this hub accepts beyond the local-client ones.
 *
 * DERIVED FIRST, configured second. A remote hub already MUST declare
 * `SLAYZONE_HUB_PUBLIC_ADDRESS` (`startServer` refuses to boot otherwise) — that
 * is, by definition, the address a browser reaches it at. Deriving the origin
 * from it means a hub that serves a web UI needs no new configuration and cannot
 * have the two values drift apart.
 *
 * `SLAYZONE_HUB_ALLOWED_WEB_ORIGINS` is the escape hatch for the deployment the
 * derivation cannot see: a second hostname, or a reverse proxy terminating TLS on
 * a name that differs from the hub's own public address. Comma-separated, parsed
 * defensively (blank entries and unparseable values dropped) in the style of
 * `allowedRoots` in slayzone-config.ts.
 *
 * Each entry is normalized to a bare origin (`scheme://host[:port]`) so a value
 * with a trailing path or slash still matches what a browser actually sends.
 */
export function resolveAllowedWebOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const origins = new Set<string>()

  const publicAddress = env.SLAYZONE_HUB_PUBLIC_ADDRESS?.trim()
  if (publicAddress) {
    // Authority-only by grammar (host[:port], no scheme — see hub-addr.ts), and
    // the scheme follows the mode: a remote hub serves TLS.
    const scheme = env.SLAYZONE_MODE === 'remote' ? 'https' : 'http'
    const derived = normalizeOrigin(`${scheme}://${publicAddress}`)
    if (derived) origins.add(derived)
  }

  for (const raw of (env.SLAYZONE_HUB_ALLOWED_WEB_ORIGINS ?? '').split(',')) {
    const normalized = normalizeOrigin(raw.trim())
    if (normalized) origins.add(normalized)
  }

  return [...origins]
}

/** `scheme://host[:port]` for a parseable absolute URL, else null. */
function normalizeOrigin(value: string): string | null {
  if (!value) return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}
