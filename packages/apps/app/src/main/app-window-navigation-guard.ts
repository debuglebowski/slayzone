import type { WebContents } from 'electron'

export type AppWindowNavigation = 'allow' | 'open-external' | 'block'

const EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:'])

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** Same app document: the packaged `file://` renderer page, or the dev server origin. */
function isSameApp(current: URL, target: URL): boolean {
  if (current.protocol === 'file:') {
    return target.protocol === 'file:' && target.pathname === current.pathname
  }
  return target.origin === current.origin
}

/**
 * What a main-frame navigation of an app window may do. The window shows the
 * app, never a website: anything that would replace it with one opens in the
 * external browser instead (same policy as the window-open handler), and any
 * other document — another local file, an app protocol — is refused.
 *
 * Measured trigger: a plain click on a PDF link that beats main's link bridge
 * makes Chromium's PDF viewer call `chrome.tabs.update`, which navigated the
 * whole app window to the link (see `pdf-viewer-links.ts`).
 */
export function resolveAppWindowNavigation(
  currentUrl: string,
  targetUrl: string
): AppWindowNavigation {
  const target = parse(targetUrl)
  if (!target) return 'block'
  const current = parse(currentUrl)
  if (current && isSameApp(current, target)) return 'allow'
  return EXTERNAL_PROTOCOLS.has(target.protocol) ? 'open-external' : 'block'
}

/** Guard an app window's main frame (main window, task windows). */
export function attachAppWindowNavigationGuard(
  wc: WebContents,
  openExternal: (url: string) => void
): void {
  wc.on('will-navigate', (event, url) => {
    const action = resolveAppWindowNavigation(wc.getURL(), url)
    if (action === 'allow') return
    event.preventDefault()
    if (action === 'open-external') openExternal(url)
  })
}
