/**
 * The client address of a hub request: the TCP peer, or — only when that peer is a
 * front end the hub trusts — the client that front end reports in `X-Forwarded-For`.
 *
 * WHY. A hub other machines reach sits behind a front end that terminates TLS (an
 * Azure Application Gateway, Caddy, nginx), so every request's TCP peer is that front
 * end. The audit `ip`, better-auth's session row and its rate limiter all want the
 * user instead. The front end appends the address it accepted the connection from to
 * `X-Forwarded-For`; the hub believes that header only when the peer is one of
 * {@link HUB_TRUSTED_PROXIES_ENV}, and only as far as the chain is trusted.
 *
 * THE RULE ({@link resolveClientAddress}). Peer not trusted → the peer, header
 * ignored. Peer trusted → walk `X-Forwarded-For` right to left, skip entries that are
 * themselves trusted, take the first that is not. A malformed entry stops the walk
 * and the result is the last hop already vouched for (the peer or a trusted entry),
 * never the malformed value and never anything left of it: everything left of the
 * first untrusted hop was written by the client. Every hop trusted → the leftmost.
 *
 * ENTRY FORMS. `a.b.c.d`, `a.b.c.d:port` (Application Gateway v2 appends `IP:port`:
 * "The format for x-forwarded-for header is a comma-separated list of IP:port",
 * learn.microsoft.com/azure/application-gateway/how-application-gateway-works),
 * `v6`, `[v6]`, `[v6]:port`, IPv4-mapped IPv6 (`::ffff:a.b.c.d`, read as the IPv4
 * address). Whitespace around entries and empty list elements are ignored; several
 * header lines are one list in order (Node joins them with `, `). An unbracketed
 * `v6:port` cannot be told from an address, so it is read as the address it parses
 * as — or, when it does not parse, as malformed.
 *
 * NEVER TRUSTED for anything: `X-Forwarded-Host`, `X-Forwarded-Proto`,
 * `X-Original-Host`. The scheme and host come from `SLAYZONE_HUB_PUBLIC_ADDRESS`
 * (CLAUDE.md env rule 5), never from a request.
 *
 * ONE RESOLUTION PER REQUEST. The hub calls {@link adoptClientAddress} first thing
 * for every HTTP request and WebSocket upgrade; everything later reads
 * {@link clientAddress} (audit context, computer sockets, rate limits) instead of
 * re-parsing. The same call writes {@link CLIENT_ADDRESS_HEADER}, the only header
 * better-auth reads an IP from (hub-auth `auth.ts`).
 *
 * Default (unset/empty list) = trust nobody = the TCP peer, as before. Peer
 * addresses are canonical (`::ffff:a.b.c.d` → `a.b.c.d`, IPv6 compressed, lowercase).
 *
 * Lean leaf (node builtins only), the `@slayzone/platform/client-address` subpath.
 *
 * @module platform/client-address
 */
import { BlockList, isIP } from 'node:net'
import { isLoopbackAuthority } from './hub-addr'
import { HUB_ADDRESS_ENV, HUB_TRUSTED_PROXIES_ENV } from './hub-switches'

export { HUB_TRUSTED_PROXIES_ENV }

/**
 * The one header better-auth reads a client IP from. Never trusted from a client: the
 * hub deletes it and writes the resolved address on every request
 * ({@link adoptClientAddress}).
 */
export const CLIENT_ADDRESS_HEADER = 'x-slayzone-client-ip'

/** The front ends whose `X-Forwarded-For` the hub believes. */
export interface TrustedProxies {
  /** The entries as configured, canonical (`a.b.c.d`, `a.b.c.d/n`, `v6`, `v6/n`). */
  readonly entries: readonly string[]
  /** Is this canonical address (from {@link canonicalAddress}) a trusted front end? */
  has(address: string): boolean
}

/** Trust nobody: the default, and the desktop app's hub. */
export const NO_TRUSTED_PROXIES: TrustedProxies = { entries: [], has: () => false }

export type TrustedProxiesParse =
  | { ok: true; value: TrustedProxies }
  | { ok: false; invalid: string[]; message: string }

/**
 * Canonical text form of an IP address, or null when `raw` is not exactly one.
 * IPv4 stays dotted decimal (Node's `isIP` already refuses leading zeros and short
 * forms), IPv6 is compressed and lowercased, an IPv4-mapped IPv6 address becomes the
 * IPv4 address it carries. A zone id (`fe80::1%en0`) is refused: it is not an address
 * another hop can name.
 */
export function canonicalAddress(raw: string): string | null {
  const family = isIP(raw)
  if (family === 4) return raw
  if (family !== 6 || raw.includes('%')) return null
  let host: string
  try {
    host = new URL(`http://[${raw}]`).hostname.slice(1, -1)
  } catch {
    return null
  }
  // WHATWG serializes `::ffff:1.2.3.4` as `::ffff:102:304`.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (mapped) {
    const hi = Number.parseInt(mapped[1]!, 16)
    const lo = Number.parseInt(mapped[2]!, 16)
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  }
  return host
}

/** One trusted-list entry → `[canonical network, prefix]`, or null. `/0` is refused. */
function parseTrustedEntry(entry: string): [string, number] | null {
  const slash = entry.indexOf('/')
  const ipPart = slash === -1 ? entry : entry.slice(0, slash)
  const family = isIP(ipPart)
  const ip = canonicalAddress(ipPart)
  if (!ip || family === 0) return null
  let bits = family === 4 ? 32 : 128
  if (slash !== -1) {
    const prefix = entry.slice(slash + 1)
    if (!/^\d{1,3}$/.test(prefix)) return null
    bits = Number(prefix)
    if (bits > (family === 4 ? 32 : 128)) return null
  }
  // An IPv4-mapped network (`::ffff:10.0.0.0/104`) is the IPv4 network it maps, which
  // is what a peer is compared against after canonicalAddress. Shorter prefixes reach
  // outside the mapped block — write those as IPv4.
  if (family === 6 && isIP(ip) === 4) {
    if (bits < 96) return null
    bits -= 96
  }
  // `/0` would trust every address, so any client could name its own IP.
  if (bits === 0) return null
  return [ip, bits]
}

/**
 * Parse {@link HUB_TRUSTED_PROXIES_ENV}: comma-separated IPs and CIDRs, IPv4 and
 * IPv6, whitespace and empty elements ignored. Unset or blank = trust nobody. Any
 * entry that is not an IP or `IP/prefix` fails the whole value (boot rule B15) — a
 * typo must not quietly trust less, or more, than the operator wrote.
 */
export function parseTrustedProxies(raw: string | undefined): TrustedProxiesParse {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (list.length === 0) return { ok: true, value: NO_TRUSTED_PROXIES }
  const blocks = new BlockList()
  const entries: string[] = []
  const invalid: string[] = []
  for (const item of list) {
    const parsed = parseTrustedEntry(item)
    if (!parsed) {
      invalid.push(item)
      continue
    }
    const [ip, bits] = parsed
    const type = isIP(ip) === 4 ? 'ipv4' : 'ipv6'
    blocks.addSubnet(ip, bits, type)
    entries.push(bits === (type === 'ipv4' ? 32 : 128) ? ip : `${ip}/${bits}`)
  }
  if (invalid.length > 0) {
    return {
      ok: false,
      invalid,
      message:
        `[slayzone] ${HUB_TRUSTED_PROXIES_ENV} must be a comma-separated list of IP addresses ` +
        `and CIDR ranges (IPv4 or IPv6, e.g. 10.93.4.0/24), got ${invalid
          .map((v) => `'${v}'`)
          .join(', ')}. A /0 range is refused: it would trust every address, so any ` +
        `client could set its own X-Forwarded-For. List only your front end's addresses.`
    }
  }
  return {
    ok: true,
    value: {
      entries,
      has: (address) => {
        const family = isIP(address)
        return family !== 0 && blocks.check(address, family === 4 ? 'ipv4' : 'ipv6')
      }
    }
  }
}

/** {@link parseTrustedProxies} of `env`'s {@link HUB_TRUSTED_PROXIES_ENV}. */
export function readTrustedProxies(env: NodeJS.ProcessEnv = process.env): TrustedProxiesParse {
  return parseTrustedProxies(env[HUB_TRUSTED_PROXIES_ENV])
}

/**
 * The boot warning for a hub that serves a non-loopback public address — so clients
 * reach it through a front end that terminates TLS (rule A1) — but trusts no front end:
 * every user is then recorded, and rate-limited, as the front end's address. Null when
 * there is nothing to say. A warning, not a refusal: a front end that connects from
 * the client's own address (a TCP pass-through) needs no list.
 */
export function trustedProxiesBootWarning(
  publicAddress: string | undefined,
  trusted: TrustedProxies
): string | null {
  if (publicAddress === undefined || isLoopbackAuthority(publicAddress)) return null
  if (trusted.entries.length > 0) return null
  return (
    `[slayzone] warning: ${HUB_ADDRESS_ENV.public}=${publicAddress} is reached through a ` +
    `front end, but ${HUB_TRUSTED_PROXIES_ENV} is empty, so the hub trusts no ` +
    `X-Forwarded-For: every audit line, session and rate limit will carry the front ` +
    `end's address instead of the user's. Set it to the front end's IPs/CIDRs (e.g. its ` +
    `subnet).`
  )
}

/** One `X-Forwarded-For` element → canonical address, or null when malformed. */
function parseForwardedEntry(entry: string): string | null {
  if (entry.startsWith('[')) {
    // `[v6]` or `[v6]:port`.
    const m = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(entry)
    if (!m || isIP(m[1]!) !== 6 || (m[2] !== undefined && Number(m[2]) > 65535)) return null
    return canonicalAddress(m[1]!)
  }
  // `a.b.c.d:port` — exactly one colon, IPv4 before it.
  const colon = entry.indexOf(':')
  if (colon !== -1 && colon === entry.lastIndexOf(':')) {
    const port = entry.slice(colon + 1)
    const host = entry.slice(0, colon)
    if (isIP(host) !== 4 || !/^\d{1,5}$/.test(port) || Number(port) > 65535) return null
    return host
  }
  return canonicalAddress(entry)
}

/** The `X-Forwarded-For` list elements, in order, from however many header lines. */
function forwardedElements(header: string | readonly string[] | undefined): string[] {
  if (header === undefined) return []
  const joined = typeof header === 'string' ? header : header.join(',')
  return joined
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** The peer as reported by the kernel, canonical; a link-local zone id is dropped. */
function canonicalPeer(peer: string | null | undefined): string | null {
  if (!peer) return null
  const pct = peer.indexOf('%')
  return canonicalAddress(pct === -1 ? peer : peer.slice(0, pct))
}

/**
 * The client address for a request that arrived from `peer` carrying `forwardedFor`
 * (the raw `X-Forwarded-For` value(s)) — see the module note for the rule. Null only
 * when there is no peer (a destroyed socket). A peer that is not an IP (never from a
 * real socket) is returned as is and trusted for nothing.
 */
export function resolveClientAddress(
  peer: string | null | undefined,
  forwardedFor: string | readonly string[] | undefined,
  trusted: TrustedProxies
): string | null {
  const canonical = canonicalPeer(peer)
  if (canonical === null) return peer || null
  if (!trusted.has(canonical)) return canonical
  const chain = forwardedElements(forwardedFor)
  let vouched = canonical
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = parseForwardedEntry(chain[i]!)
    // Malformed: stop. Left of it is client-written; the value itself means nothing.
    if (hop === null) return vouched
    if (!trusted.has(hop)) return hop
    vouched = hop
  }
  return vouched
}

/** The parts of a request (an `IncomingMessage`, or anything shaped like one) used here. */
export interface ClientAddressRequest {
  socket?: { remoteAddress?: string | undefined } | null
  headers: Record<string, string | string[] | undefined>
}

const adopted = new WeakMap<object, string>()

/**
 * Resolve `req`'s client address once, at the hub's front door, and make it the
 * request's: {@link clientAddress} returns it from here on, and
 * {@link CLIENT_ADDRESS_HEADER} is replaced with it (deleted when there is none), so
 * a client can never supply that header itself. Returns the address.
 */
export function adoptClientAddress(
  req: ClientAddressRequest,
  trusted: TrustedProxies
): string | null {
  const address = resolveClientAddress(
    req.socket?.remoteAddress,
    req.headers['x-forwarded-for'],
    trusted
  )
  delete req.headers[CLIENT_ADDRESS_HEADER]
  if (address) {
    adopted.set(req, address)
    req.headers[CLIENT_ADDRESS_HEADER] = address
  }
  return address
}

/**
 * The client address of a request: what {@link adoptClientAddress} resolved for it,
 * else its TCP peer as reported (a server that never adopts — the desktop's own tRPC
 * listener, test harnesses — behaves as before). This is what the audit `ip` and any
 * rate limit should key on.
 */
export function clientAddress(
  req: { socket?: { remoteAddress?: string | undefined } | null } | null | undefined
): string | null {
  if (!req) return null
  const resolved = adopted.get(req)
  if (resolved) return resolved
  const addr = req.socket?.remoteAddress
  return typeof addr === 'string' && addr ? addr : null
}
