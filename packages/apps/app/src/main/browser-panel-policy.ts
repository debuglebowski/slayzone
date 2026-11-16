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
 * device's own local agent) acts only on a tab in an ISOLATED partition's session —
 * never in the user's own browser, on the local hub or a remote one. The session is
 * fixed when the tab's web contents is made, so nothing a page does (history, popups,
 * `_blank`, workers) changes the answer.
 */
export function untrustedOpRefusal(untrustedOp: boolean, isolatedSession: boolean): string | null {
  if (!untrustedOp || isolatedSession) return null
  return "That tab is the user's own browser (their logins and local pages). An agent on another computer or on a remote hub may only use isolated tabs, which have their own empty browser: open one with `slay browser new`."
}

/**
 * What an UNTRUSTED session's pages may be granted (request AND check handler):
 * deny by default. Its pages are a remote hub's or an agent elsewhere's, so nothing
 * that reaches the user or this machine — camera/mic, screen, clipboard (read or
 * write: pasting into a terminal), MIDI, location, notifications, devices, fullscreen
 * or pointer/keyboard lock (fake UI), storage access, opening other apps. Only
 * playback of protected media, which touches none of that.
 */
const UNTRUSTED_ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['mediaKeySystem'])

export function untrustedPermissionAllowed(permission: string): boolean {
  return UNTRUSTED_ALLOWED_PERMISSIONS.has(permission)
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

  /**
   * `userAccess`: for the user's OWN tabs in an untrusted session (a remote hub's
   * partition, never an isolated one) — may this non-public request go ahead because
   * the user asked for it ({@link UserLocalAccess})? Asked for every web request, so a
   * main-frame request spends a pending user act whatever its target.
   */
  async decide(
    req: PanelRequest,
    ctx: {
      untrustedSession: boolean
      resolveIn?: unknown
      userAccess?: (req: PanelRequest, nonPublic: boolean) => boolean
    }
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
      const nonPublic = await this.isNonPublicHost(url.hostname, req.webContentsId, ctx.resolveIn)
      const userAsked = ctx.userAccess?.(req, nonPublic) ?? false
      return nonPublic && !userAsked ? 'block' : 'allow'
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
 * The user's own tabs in a REMOTE hub's partition run under the untrusted policy (the
 * hub plants their stored URLs), yet the user should reach localhost / their LAN from
 * them — a local dev server, say. So a non-public address is allowed there only on the
 * user's own act, never on anything the hub or a page starts by itself:
 *
 *  - a main-frame navigation the user started: typed in the address bar (that address,
 *    once), back / forward / reload from the panel, or right after real input in the tab
 *    (a click on a link) — and its origin becomes one the user opened in that tab;
 *  - any request of a page whose top document is such a user-opened local origin (the
 *    user's own local page, loading its resources and calling its APIs).
 *
 * A stored URL loading at start, a page navigating itself, or a public page's request
 * to this machine (local-network CSRF) stays blocked. Isolated partitions (the agents'
 * tabs) never get this. Pure; `now` injected.
 */
export class UserLocalAccess {
  /** A pending user navigation per web contents: the typed URL, or null (back /
   *  forward / reload: whichever URL it lands on). Spent by the next main frame. */
  private readonly pending = new Map<number, { url: string | null; at: number }>()
  /** Non-public origins the user opened, per web contents. */
  private readonly opened = new Map<number, Set<string>>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs = 10_000
  ) {}

  /** The user navigates this tab from the panel (`url` typed, or null). */
  userNavigates(webContentsId: number, url: string | null): void {
    this.pending.set(webContentsId, { url, at: this.now() })
  }

  allows(req: PanelRequest, ctx: { nonPublic: boolean; gesture: boolean }): boolean {
    const id = req.webContentsId
    if (id === null) return false
    const origin = originOf(req.url)
    if (req.resourceType === 'mainFrame') {
      const p = this.pending.get(id)
      this.pending.delete(id)
      if (!ctx.nonPublic || !origin) return false
      const typed =
        !!p && this.now() - p.at <= this.windowMs && (p.url === null || originOf(p.url) === origin)
      if (!typed && !ctx.gesture) return false
      let set = this.opened.get(id)
      if (!set) this.opened.set(id, (set = new Set()))
      set.add(origin)
      return true
    }
    const top = originOf(req.topUrl)
    return ctx.nonPublic && !!top && (this.opened.get(id)?.has(top) ?? false)
  }

  forget(webContentsId: number): void {
    this.pending.delete(webContentsId)
    this.opened.delete(webContentsId)
  }
}

function originOf(raw: string): string | null {
  const u = parse(raw)
  return u && u.origin !== 'null' ? u.origin : null
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
