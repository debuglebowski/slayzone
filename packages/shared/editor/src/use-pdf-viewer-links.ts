import { useEffect, type RefObject } from 'react'
import { useStableCallback } from '@slayzone/ui'
import {
  PDF_VIEWER_EXTENSION_ORIGIN,
  parsePdfViewerLinkMessage,
  resolvePdfLinkAction
} from '@slayzone/platform/pdf-viewer-links'
import type { LinkOpenTarget } from './milkdown-link-click'

/** True when `source` is `frame`'s window or any window nested inside it. */
export function isWindowWithin(source: MessageEventSource | null, frame: Window | null): boolean {
  if (!source || !frame || !('parent' in source)) return false
  let w: Window = source
  for (let depth = 0; depth < 8; depth++) {
    if (w === frame) return true
    if (w.parent === w) return false
    w = w.parent
  }
  return false
}

/**
 * Link clicks inside a PDF shown in `iframeRef`, relayed by the bridge main
 * injects into Chromium's viewer frame (`@slayzone/platform/pdf-viewer-links`).
 * Only messages from the viewer origin AND from inside this iframe are honored.
 */
export function usePdfViewerLinks(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  onOpenLink: (href: string, target: LinkOpenTarget) => void
): void {
  const handleMessage = useStableCallback((event: MessageEvent) => {
    if (event.origin !== PDF_VIEWER_EXTENSION_ORIGIN) return
    if (!isWindowWithin(event.source, iframeRef.current?.contentWindow ?? null)) return
    const msg = parsePdfViewerLinkMessage(event.data)
    if (msg) onOpenLink(msg.url, resolvePdfLinkAction(msg.intent))
  })
  useEffect(() => {
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [handleMessage])
}
