import {
  BROWSER_CREATE_TASK_FROM_LINK_BRIDGE_KEY,
  BROWSER_CREATE_TASK_FROM_LINK_INSTALLED_KEY,
  buildBrowserCreateTaskFromLinkCaptureScript,
} from '../shared/browser-link-task-capture-script'

export {
  BROWSER_CREATE_TASK_FROM_LINK_BRIDGE_KEY,
  BROWSER_CREATE_TASK_FROM_LINK_INSTALLED_KEY,
  buildBrowserCreateTaskFromLinkCaptureScript,
}

export interface BrowserCreateTaskFromLinkCapturePayload {
  url: string
  linkText?: string
}

interface ClosestCapableTarget {
  closest: (selector: string) => Element | null
}

function isClosestCapableTarget(value: unknown): value is ClosestCapableTarget {
  return typeof value === 'object' && value !== null && 'closest' in value && typeof value.closest === 'function'
}

function readAnchorHref(anchor: Element): string {
  if ('href' in anchor && typeof anchor.href === 'string') return anchor.href
  return anchor.getAttribute('href') ?? ''
}

function readAnchorText(anchor: Element): string {
  if ('innerText' in anchor && typeof anchor.innerText === 'string' && anchor.innerText.trim()) return anchor.innerText
  return anchor.textContent || anchor.getAttribute('aria-label') || ''
}

function findNearestAnchor(event: MouseEvent): Element | null {
  const candidates: unknown[] = [event.target]
  if (typeof event.composedPath === 'function') {
    for (const node of event.composedPath()) candidates.push(node)
  }
  if (
    Number.isFinite(event.clientX) &&
    Number.isFinite(event.clientY) &&
    typeof document.elementFromPoint === 'function'
  ) {
    candidates.push(document.elementFromPoint(event.clientX, event.clientY))
  }

  for (const candidate of candidates) {
    if (!isClosestCapableTarget(candidate)) continue
    try {
      const anchor = candidate.closest('a[href]')
      if (anchor) return anchor
    } catch {
      // Ignore cross-realm access errors and continue scanning candidates.
    }
  }
  return null
}

export function extractCreateTaskFromLinkPayload(event: MouseEvent): BrowserCreateTaskFromLinkCapturePayload | null {
  if (!event.altKey || !event.shiftKey || event.metaKey || event.ctrlKey) return null
  if (event.button !== 0) return null

  const anchor = findNearestAnchor(event)
  if (!anchor) return null

  let href = ''
  try {
    href = readAnchorHref(anchor)
  } catch {
    return null
  }
  if (!/^https?:\/\//i.test(href)) return null

  let linkText = ''
  try {
    linkText = readAnchorText(anchor)
  } catch {
    linkText = ''
  }

  return {
    url: href,
    linkText: linkText.replace(/\s+/g, ' ').trim() || undefined,
  }
}

export function installBrowserCreateTaskFromLinkCapture(bridgeKey: string, installedKey: string): void {
  const bridgeWindow = window as unknown as Record<string, unknown>
  if (bridgeWindow[installedKey] === document) return

  let lastForwardedSignature = ''
  let lastForwardedAt = 0
  const forwardPayload = (payload: BrowserCreateTaskFromLinkCapturePayload): void => {
    const signature = `${payload.url}::${payload.linkText ?? ''}`
    const now = Date.now()
    if (signature === lastForwardedSignature && now - lastForwardedAt < 750) return
    lastForwardedSignature = signature
    lastForwardedAt = now

    const bridge = bridgeWindow[bridgeKey]
    if (typeof bridge === 'function') {
      ;(bridge as (payload: BrowserCreateTaskFromLinkCapturePayload) => void)(payload)
    }
  }

  document.addEventListener('mousedown', (event) => {
    const payload = extractCreateTaskFromLinkPayload(event)
    if (!payload) return

    // Chromium can decide modifier-based link actions on mouse down.
    // Prevent here so Alt+Shift+Click never escapes into a new BrowserWindow.
    event.preventDefault()
    event.stopPropagation()
    forwardPayload(payload)
  }, true)

  document.addEventListener('click', (event) => {
    const payload = extractCreateTaskFromLinkPayload(event)
    if (!payload) return

    event.preventDefault()
    event.stopPropagation()
    forwardPayload(payload)
  }, true)

  bridgeWindow[installedKey] = document
}
