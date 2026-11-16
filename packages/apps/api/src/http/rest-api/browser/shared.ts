import type { Request, Response } from 'express'
import { isNonPublicHostname } from '@slayzone/platform/browser-network'
import type { BrowserAccess, RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'

export const BROWSER_JS_TIMEOUT = 10_000
export const ALLOWED_NAVIGATE_SCHEMES = ['http:', 'https:', 'file:']

export interface BrowserTabResult {
  /** The tabId actually targeted (resolved from an explicit tabId or the active tab). */
  tabId: string | null
  /** true when the panel was just auto-opened (renderer already navigated to `url`) */
  autoOpened: boolean
}

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
  const trustedLocal = browser.isDesktopLocalHub && browser.originOf(req) === 'hub-machine'
  if (trustedLocal) return false
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
  if (await browser.hasBrowserTab(taskId, tabId)) {
    return { tabId: await browser.getResolvedBrowserTabId(taskId, tabId), autoOpened: false }
  }
  if (!browser.hasCapableClient(req)) {
    res.status(503).json({ error: NO_DESKTOP })
    return null
  }

  if (panel === 'visible') {
    const origin = browser.originOf(req)
    deps.menu?.emit('browser-ensure-panel-open', { taskId, url, tabId, origin })
    deps.legacyBroadcast?.('browser:ensure-panel-open', taskId, url, tabId) // slice 5: drop legacy send
    try {
      await browser.waitForBrowserRegistration(taskId, { tabId })
      return {
        tabId: await browser.getResolvedBrowserTabId(taskId, tabId),
        autoOpened: !!url
      }
    } catch (err) {
      res.status(408).json({ error: err instanceof Error ? err.message : String(err) })
      return null
    }
  }

  const tabs = await browser.listBrowserTabs(taskId)
  res.status(404).json({
    error: tabId
      ? `Browser tab '${tabId}' not found for task ${taskId}.`
      : 'Browser panel not found. Is the browser panel open on this task?',
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
  taskId: string,
  tabId: string | null,
  code: string,
  origin: 'hub-machine' | 'elsewhere'
): Promise<T> {
  return Promise.race([
    browser.execJs(taskId, tabId, code, origin) as Promise<T>,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Browser script timed out (10s)')), BROWSER_JS_TIMEOUT)
    )
  ])
}
