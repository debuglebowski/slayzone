import type { Request, Response } from 'express'
import { isNonPublicHostname } from '@slayzone/platform/browser-network'
import type { BrowserAccess, BrowserCaller, RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'

export const BROWSER_JS_TIMEOUT = 10_000
export const ALLOWED_NAVIGATE_SCHEMES = ['http:', 'https:', 'file:']

export interface BrowserTabResult {
  /** The tabId actually targeted (resolved from an explicit tabId or the active tab). */
  tabId: string | null
  /** true when the panel was just auto-opened (renderer already navigated to `url`) */
  autoOpened: boolean
}

/** An untrusted caller named one of the user's own tabs. */
export function ownTabRefusal(tabId: string): string {
  return `Tab '${tabId}' is the user's own browser (their logins and local pages). An agent on another computer or on a remote hub may only use isolated tabs, which have their own empty browser: open one with \`slay browser new\`.`
}

/** An untrusted caller, no isolated tab open. */
export const NO_ISOLATED_TAB =
  "No isolated browser tab is open for this task. An agent on another computer or on a remote hub may only use isolated tabs (their own empty browser, never the user's): open one with `slay browser new`, or pass --panel visible."

/** No client that can host the browser panel is connected for the caller. */
export const NO_DESKTOP =
  'No SlayZone desktop app is connected to this hub for you; the browser panel runs in the desktop app. Open the task there.'

/**
 * Refuse (403) a URL the desktop would refuse from this caller, so `slay browser`
 * says so instead of answering ok while the panel opens blank. The desktop enforces it
 * regardless (task-browser `runRelayRequest` / `hubMayNavigateTo`); this only reports.
 * Returns true when it answered.
 */
export function refuseTarget(
  browser: BrowserAccess,
  req: Request,
  url: string,
  res: Response
): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (isTrustedLocal(browser, browser.callerOf(req))) return false
  if (parsed.protocol === 'file:') {
    res.status(403).json({
      error:
        'A local file can only be opened from the computer the browser runs on (an agent there, on its own hub).'
    })
    return true
  }
  if (isNonPublicHostname(parsed.hostname)) {
    res.status(403).json({
      error:
        'That address is on this computer or its private network; it can only be opened from the computer the browser runs on.'
    })
    return true
  }
  return false
}

/**
 * The caller is an agent on the desktop's own machine, through that desktop's own
 * local hub — the one caller whose URL the desktop opens as the user's own (it decides
 * too; this only predicts it). Anyone else's URL is never handed to the desktop to open
 * directly: the tab opens blank and the URL loads through the relay, where the desktop
 * resolves the name first (`10.0.0.1.nip.io` is a private address) and reports a refusal.
 */
export function isTrustedLocal(browser: BrowserAccess, caller: BrowserCaller): boolean {
  return browser.isDesktopLocalHub && caller.origin === 'hub-machine'
}

/** 501s + returns null when the host has no WCV browser (standalone server). */
export function requireBrowser(deps: RestApiDeps, res: Response): BrowserAccess | null {
  if (!deps.browser) {
    res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
    return null
  }
  return deps.browser
}

/**
 * Resolve the browser tab a request targets, opening the panel first when asked.
 *
 * Returns an IDENTIFIER, not a handle — see `BrowserAccess`. Every branch and
 * status code is unchanged from the `ensureBrowserWc` version this replaces: 501
 * with no browser, 400 without a taskId, 408 when an auto-open never registers,
 * 404 (with the tab list) when the panel isn't open and we weren't asked to open it.
 */
export async function ensureBrowserTab(
  deps: RestApiDeps,
  req: Request,
  taskId: string | undefined,
  panel: 'visible' | 'hidden' | undefined,
  res: Response,
  url?: string,
  tabId?: string
): Promise<BrowserTabResult | null> {
  const browser = requireBrowser(deps, res)
  if (!browser) return null
  if (!taskId) {
    res.status(400).json({ error: 'taskId required' })
    return null
  }
  if (url && refuseTarget(browser, req, url, res)) return null
  const caller = browser.callerOf(req)
  const trusted = isTrustedLocal(browser, caller)
  if (tabId && !trusted && (await browser.isUsersOwnTab(caller, taskId, tabId))) {
    res.status(403).json({ error: ownTabRefusal(tabId) })
    return null
  }
  if (await browser.hasBrowserTab(caller, taskId, tabId)) {
    return {
      tabId: await browser.getResolvedBrowserTabId(caller, taskId, tabId),
      autoOpened: false
    }
  }
  if (!browser.hasCapableClient(caller)) {
    res.status(503).json({ error: NO_DESKTOP })
    return null
  }

  if (panel === 'visible') {
    // Only the trusted local agent's URL opens with the panel; anyone else's loads
    // through the relay once the tab is live (`autoOpened: false` → the caller loads it).
    // An untrusted caller with no tab named gets a NEW isolated tab to work in.
    const openWith = url && trusted ? url : undefined
    deps.menu?.emit('browser-ensure-panel-open', {
      taskId,
      url: openWith,
      tabId,
      origin: caller.origin,
      principal: caller.principal,
      isolated: !trusted && !tabId
    })
    deps.legacyBroadcast?.('browser:ensure-panel-open', taskId, openWith, tabId) // slice 5: drop legacy send
    try {
      await browser.waitForBrowserRegistration(caller, taskId, { tabId })
      return {
        tabId: await browser.getResolvedBrowserTabId(caller, taskId, tabId),
        autoOpened: !!openWith
      }
    } catch (err) {
      res.status(408).json({ error: err instanceof Error ? err.message : String(err) })
      return null
    }
  }

  const tabs = (await browser.listBrowserTabs(caller, taskId)).filter((t) => trusted || t.isolated)
  res.status(404).json({
    error: tabId
      ? `Browser tab '${tabId}' not found for task ${taskId}.`
      : trusted
        ? 'Browser panel not found. Is the browser panel open on this task?'
        : NO_ISOLATED_TAB,
    tabs
  })
  return null
}

/**
 * Run JS in the target tab under the 10s cap.
 *
 * The race stays HERE rather than behind the bridge: the timeout is the route's
 * contract with its caller, so it has to hold whether the operation is answered by
 * an in-process WebContents or by a bridged desktop that never replies at all.
 */
export function execJs<T>(
  browser: BrowserAccess,
  caller: BrowserCaller,
  taskId: string,
  tabId: string | null,
  code: string
): Promise<T> {
  return Promise.race([
    browser.execJs(caller, taskId, tabId, code) as Promise<T>,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Browser script timed out (10s)')), BROWSER_JS_TIMEOUT)
    )
  ])
}
