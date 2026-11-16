import { isNonPublicHostname, parseIp, isNonPublicIp } from '@slayzone/platform/browser-network'

/** Resolve a hostname to its addresses — Electron main passes the tab session's own
 *  Chromium resolver (`session.resolveHost`), the host cache its connections use.
 *  `resolveIn`: the session the request came from, for a request with no web contents
 *  (a service or shared worker). */
export type HostLookup = (
  host: string,
  webContentsId: number | null,
  resolveIn?: unknown
) => Promise<string[]>

/** One request, as `webRequest.onBeforeRequest` reports it. */
export interface PanelRequest {
  url: string
  /** Electron `resourceType`: `mainFrame`, `subFrame`, `image`, `xhr`, … */
  resourceType: string
  /** Null for a request no web contents made (a service or shared worker). */
  webContentsId: number | null
  /** The URL of the tab's top-level document (empty while the first one loads). */
  topUrl: string
}

const WEB = new Set(['http:', 'https:', 'ws:', 'wss:'])
const DOCUMENT = new Set(['mainFrame', 'subFrame'])

/**
 * Why an op may not run on a tab, or null. An untrusted caller (anyone but this
 * device's own local agent) acts only on a tab in an UNTRUSTED SESSION — an isolated
 * tab's partition or a remote hub's — never in the user's own browser. The session
 * is fixed when the tab's web contents is made, so nothing a page does (history,
 * popups, `_blank`, workers) changes the answer.
 */
export function untrustedOpRefusal(untrustedOp: boolean, untrustedSession: boolean): string | null {
  if (!untrustedOp || untrustedSession) return null
  return "That tab is the user's own browser (their logins and local pages). An agent on another computer or on a remote hub may only use isolated tabs, which have their own empty browser: open one with `slay browser new`."
}

/**
 * The browser panel's SESSION-LEVEL request policy. Electron main runs every request
 * of every panel session through {@link PanelNetworkPolicy.decide} — not a list of
 * things to deny, but the only things allowed:
 *
 *  - UNTRUSTED SESSION (the isolated partition — tabs opened for an agent on another
 *    computer — and every remote hub's partition): http/https/ws/wss to PUBLIC
 *    addresses only — judged on the numeric address of the literal or of every DNS
 *    answer, so no textual form of loopback/private/link-local/NAT64/6to4 passes —
 *    plus `about:blank` and inert `data:`/`blob:` subresources. No local file, no
 *    extension or app scheme, in any position, from any frame, popup or worker of
 *    the session (a request with no web contents is judged by its session too).
 *  - The user's own browser (`persist:browser-tabs`): everything as before, except that
 *    a local file (`slz-file:`) is never part of a web page: it opens as a document, or
 *    loads into a local file's own document, and nowhere else. No untrusted caller
 *    ever acts in it ({@link untrustedOpRefusal}).
 *
 * Pure apart from the injected resolver.
 */
export class PanelNetworkPolicy {
  constructor(private readonly lookup: HostLookup) {}

  /** Throws (with why) when an untrusted caller may not navigate to `rawUrl`. */
  async checkTarget(rawUrl: string, webContentsId: number | null = null): Promise<void> {
    const url = parse(rawUrl)
    if (rawUrl === 'about:blank') return
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new Error(`Navigation to ${url?.protocol ?? 'that address'} is not allowed from here.`)
    }
    if (await this.isNonPublicHost(url.hostname, webContentsId)) {
      throw new Error(
        'That address is on this computer or its private network; it can only be opened from this computer.'
      )
    }
  }

  async decide(
    req: PanelRequest,
    ctx: { untrustedSession: boolean; resolveIn?: unknown }
  ): Promise<'allow' | 'block'> {
    const url = parse(req.url)
    if (!url) return 'block'
    if (ctx.untrustedSession) {
      if (req.url === 'about:blank') return 'allow'
      if (
        (url.protocol === 'data:' || url.protocol === 'blob:') &&
        !DOCUMENT.has(req.resourceType)
      ) {
        return 'allow'
      }
      if (!WEB.has(url.protocol)) return 'block'
      return (await this.isNonPublicHost(url.hostname, req.webContentsId, ctx.resolveIn))
        ? 'block'
        : 'allow'
    }
    // Trusted: a local file is a document of its own, never part of a web page.
    if (url.protocol === 'slz-file:' || url.protocol === 'file:') {
      if (req.resourceType === 'mainFrame') return 'allow'
      const top = parse(req.topUrl)
      return top && (top.protocol === 'slz-file:' || top.protocol === 'file:') ? 'allow' : 'block'
    }
    return 'allow'
  }

  /**
   * RESIDUAL (known, accepted): this judges the answers of a resolve made HERE, not the
   * address the connection then uses. Both go through the tab session's own Chromium
   * host cache, so they agree unless the cache entry expires and the name re-resolves
   * in between — a rebinding server with a ~0 s TTL can win that race. Electron exposes
   * no hook on the connected IP before the response (only `onBeforeRedirect`), so this
   * cannot be closed here; it is why an untrusted caller only ever works in an isolated
   * session, which holds none of the user's logins, files, schemes or hub credentials.
   */
  private async isNonPublicHost(
    hostname: string,
    webContentsId: number | null,
    resolveIn?: unknown
  ): Promise<boolean> {
    if (isNonPublicHostname(hostname)) return true
    const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
    if (parseIp(bare)) return isNonPublicIp(bare)
    let addresses: string[]
    try {
      addresses = await this.lookup(bare, webContentsId, resolveIn)
    } catch {
      return true
    }
    return addresses.length === 0 || addresses.some((a) => !parseIp(a) || isNonPublicIp(a))
  }
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/**
 * Whether a panel request carries the panel marker header (the hub refuses its API to
 * any request bearing it): only requests to where a hub may listen — this machine and
 * its private network (any IP form) or a registered hub's host. Other sites never see
 * it, so they cannot tell a page is in SlayZone's panel.
 */
export function panelMarkerNeeded(rawUrl: string, hubHosts: ReadonlySet<string>): boolean {
  const url = parse(rawUrl)
  if (!url || !WEB.has(url.protocol)) return false
  const host = url.hostname.toLowerCase()
  return isNonPublicHostname(host) || hubHosts.has(host.replace(/^\[|\]$/g, ''))
}
