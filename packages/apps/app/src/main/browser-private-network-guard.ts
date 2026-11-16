import { isNonPublicHostname, isNonPublicIp } from '@slayzone/platform/browser-network'

/** Resolve a hostname to its addresses — Electron main passes the tab session's own
 *  Chromium resolver (`session.resolveHost`), the same host cache its connections use. */
export type HostLookup = (host: string, webContentsId: number | null) => Promise<string[]>

/**
 * What an UNTRUSTED `slay browser` caller — a remote hub, or an agent on another
 * computer — can make this desktop's browser reach: the public internet only. Never
 * this machine (the desktop's own login-off hub is one `http://127.0.0.1:51100`
 * away: the loopback pivot) and never the local network.
 *
 * Three layers, because a name can lie (DNS rebinding):
 *  1. `checkTarget` before an untrusted navigation: the name, then every address it
 *     resolves to, must be public.
 *  2. While a tab's document was put there or scripted by an untrusted caller
 *     (`markUntrusted`, cleared when the user navigates it), EVERY request it makes —
 *     redirects, subresources, fetches — is re-checked the same way (`shouldBlock`),
 *     through the resolver the connection itself then uses.
 *  3. Each committed document is judged by its final URL (name + resolution), and a
 *     redirect hop served from a non-public IP counts against the document it leads
 *     to: an untrusted caller gets nothing back from a tainted tab — no script result,
 *     no screenshot, no URL — however it got there.
 *
 * The user's own browsing is untouched: only tabs an untrusted caller drives are
 * restricted, and a page the user opened on localhost merely stays unreadable to
 * remote callers. Pure apart from the injected resolver.
 */
export class PrivateNetworkGuard {
  private readonly untrusted = new Set<number>()
  /** Per tab: whether its current document is non-public (a promise while checking). */
  private readonly documentTaint = new Map<number, Promise<boolean>>()
  /** Redirect hops of the navigation in flight that came from a non-public IP. */
  private readonly pendingRedirectTaint = new Set<number>()
  /** Subresource redirects of the current document that came from a non-public IP. */
  private readonly subresourceTaint = new Set<number>()

  constructor(private readonly lookup: HostLookup) {}

  /** Throws when `rawUrl` may point at this machine or the local network. */
  async checkTarget(rawUrl: string, webContentsId: number | null = null): Promise<void> {
    if (await this.isNonPublicUrl(rawUrl, webContentsId)) {
      throw new Error(
        'That address is on this computer or its private network; it can only be opened from this computer.'
      )
    }
  }

  markUntrusted(webContentsId: number): void {
    this.untrusted.add(webContentsId)
  }

  /** The user navigated the tab: it is theirs again. */
  clearUntrusted(webContentsId: number): void {
    this.untrusted.delete(webContentsId)
  }

  isUntrusted(webContentsId: number): boolean {
    return this.untrusted.has(webContentsId)
  }

  /** Every request of an untrusted tab, before it is sent. */
  async shouldBlock(webContentsId: number, rawUrl: string): Promise<boolean> {
    if (!this.untrusted.has(webContentsId)) return false
    return this.isNonPublicUrl(rawUrl, webContentsId)
  }

  /** A redirect hop was served from `ip` (Electron's `onBeforeRedirect`). */
  noteRedirect(webContentsId: number, ip: string | undefined, mainFrame: boolean): void {
    if (!ip || !isNonPublicIp(ip)) return
    if (mainFrame) this.pendingRedirectTaint.add(webContentsId)
    else this.subresourceTaint.add(webContentsId)
  }

  /** A main-frame navigation committed to `url`: the tab's taint is now its new document's. */
  committed(webContentsId: number, url: string): void {
    const viaPrivateRedirect = this.pendingRedirectTaint.delete(webContentsId)
    this.subresourceTaint.delete(webContentsId)
    this.documentTaint.set(
      webContentsId,
      viaPrivateRedirect
        ? Promise.resolve(true)
        : this.isNonPublicUrl(url, webContentsId).catch(() => true)
    )
  }

  /** Whether the tab's current document (or a redirect it followed) touched a non-public address. */
  async isTainted(webContentsId: number): Promise<boolean> {
    if (this.subresourceTaint.has(webContentsId)) return true
    return (await this.documentTaint.get(webContentsId)) ?? false
  }

  forget(webContentsId: number): void {
    this.untrusted.delete(webContentsId)
    this.documentTaint.delete(webContentsId)
    this.pendingRedirectTaint.delete(webContentsId)
    this.subresourceTaint.delete(webContentsId)
  }

  private async isNonPublicUrl(rawUrl: string, webContentsId: number | null): Promise<boolean> {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return true
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      // about:blank, data:, blob: etc. carry no network target of their own; the
      // scheme rules (renderer) decide whether they are allowed at all.
      return false
    }
    const host = url.hostname
    if (isNonPublicHostname(host)) return true
    const bare = host.startsWith('[') ? host.slice(1, -1) : host
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(':')) return false
    let addresses: string[]
    try {
      addresses = await this.lookup(bare, webContentsId)
    } catch {
      return true
    }
    return addresses.length === 0 || addresses.some((a) => isNonPublicIp(a))
  }
}
