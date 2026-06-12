import type { Response } from 'express'
import type { BrowserAccess, BrowserWc, RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'

export const BROWSER_JS_TIMEOUT = 10_000
export const ALLOWED_NAVIGATE_SCHEMES = ['http:', 'https:', 'file:']

export interface BrowserWcResult {
  wc: BrowserWc
  /** true when the panel was just auto-opened (renderer already navigated to `url`) */
  autoOpened: boolean
  /** The tabId that was actually targeted (resolved from explicit tabId or active tab). */
  tabId: string | null
}

/** 501s + returns null when the host has no WCV browser (standalone server). */
export function requireBrowser(deps: RestApiDeps, res: Response): BrowserAccess | null {
  if (!deps.browser) {
    res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
    return null
  }
  return deps.browser
}

export async function ensureBrowserWc(
  deps: RestApiDeps,
  taskId: string | undefined,
  panel: 'visible' | 'hidden' | undefined,
  res: Response,
  url?: string,
  tabId?: string
): Promise<BrowserWcResult | null> {
  const browser = requireBrowser(deps, res)
  if (!browser) return null
  if (!taskId) {
    res.status(400).json({ error: 'taskId required' })
    return null
  }
  const wc = browser.getBrowserWebContents(taskId, tabId)
  if (wc) return { wc, autoOpened: false, tabId: browser.getResolvedBrowserTabId(taskId, tabId) }

  if (panel === 'visible') {
    deps.menu?.emit('browser-ensure-panel-open', { taskId, url, tabId })
    deps.legacyBroadcast?.('browser:ensure-panel-open', taskId, url, tabId) // slice 5: drop legacy send
    try {
      const resolved = await browser.waitForBrowserRegistration(taskId, { tabId })
      return {
        wc: resolved,
        autoOpened: !!url,
        tabId: browser.getResolvedBrowserTabId(taskId, tabId)
      }
    } catch (err) {
      res.status(408).json({ error: err instanceof Error ? err.message : String(err) })
      return null
    }
  }

  const tabs = browser.listBrowserTabs(taskId)
  res.status(404).json({
    error: tabId
      ? `Browser tab '${tabId}' not found for task ${taskId}.`
      : 'Browser panel not found. Is the browser panel open on this task?',
    tabs
  })
  return null
}

export function execJs<T>(wc: BrowserWc, code: string): Promise<T> {
  return Promise.race([
    (wc.mainFrame?.executeJavaScript(code) ??
      Promise.reject(new Error('No main frame'))) as Promise<T>,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Browser script timed out (10s)')), BROWSER_JS_TIMEOUT)
    )
  ])
}
