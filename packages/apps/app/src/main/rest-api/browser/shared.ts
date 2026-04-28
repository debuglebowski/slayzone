import type { Response } from 'express'
import { getBrowserWebContents, listBrowserTabs, waitForBrowserRegistration } from '../../browser-registry'
import { broadcastToWindows } from '../../broadcast-to-windows'

export const BROWSER_JS_TIMEOUT = 10_000
export const ALLOWED_NAVIGATE_SCHEMES = ['http:', 'https:', 'file:']

export interface BrowserWcResult {
  wc: Electron.WebContents
  /** true when the panel was just auto-opened (renderer already navigated to `url`) */
  autoOpened: boolean
  /** The tabId that was actually targeted (resolved from explicit tabId or active tab). */
  tabId: string | null
}

export async function ensureBrowserWc(
  taskId: string | undefined,
  panel: 'visible' | 'hidden' | undefined,
  res: Response,
  url?: string,
  tabId?: string,
): Promise<BrowserWcResult | null> {
  if (!taskId) { res.status(400).json({ error: 'taskId required' }); return null }
  const wc = getBrowserWebContents(taskId, tabId)
  if (wc) return { wc, autoOpened: false, tabId: tabId ?? null }

  if (panel === 'visible') {
    broadcastToWindows('browser:ensure-panel-open', taskId, url, tabId)
    try {
      const resolved = await waitForBrowserRegistration(taskId, { tabId })
      return { wc: resolved, autoOpened: !!url, tabId: tabId ?? null }
    } catch (err) {
      res.status(408).json({ error: err instanceof Error ? err.message : String(err) })
      return null
    }
  }

  const tabs = listBrowserTabs(taskId)
  res.status(404).json({
    error: tabId
      ? `Browser tab '${tabId}' not found for task ${taskId}.`
      : 'Browser panel not found. Is the browser panel open on this task?',
    tabs,
  })
  return null
}

export function execJs<T>(wc: Electron.WebContents, code: string): Promise<T> {
  return Promise.race([
    (wc.mainFrame?.executeJavaScript(code) ?? Promise.reject(new Error('No main frame'))) as Promise<T>,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Browser script timed out (10s)')), BROWSER_JS_TIMEOUT)
    ),
  ])
}
