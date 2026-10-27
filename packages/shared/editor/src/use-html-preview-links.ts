import { useEffect, type RefObject } from 'react'
import { useStableCallback } from '@slayzone/ui'
import { parseHtmlPreviewLinkMessage } from '@slayzone/platform/html-preview-links'
import { resolveReadOnlyLinkClickTarget, type LinkOpenTarget } from './milkdown-link-click'
import { isWindowWithin } from './use-pdf-viewer-links'

/**
 * Link clicks inside an HTML preview shown in `iframeRef`, relayed by the bridge
 * main injects into slz-file frames (`@slayzone/platform/html-preview-links`).
 * Only messages from inside this iframe are honored, and only while the window
 * holds transient user activation — the page runs untrusted script that can
 * post the same message, but cannot fake the click that grants activation.
 */
export function useHtmlPreviewLinks(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  onOpenLink: (href: string, target: LinkOpenTarget) => void
): void {
  const handleMessage = useStableCallback((event: MessageEvent) => {
    if (!isWindowWithin(event.source, iframeRef.current?.contentWindow ?? null)) return
    const msg = parseHtmlPreviewLinkMessage(event.data)
    if (!msg || !navigator.userActivation.isActive) return
    const target = resolveReadOnlyLinkClickTarget(msg.url, msg)
    if (target) onOpenLink(msg.url, target)
  })
  useEffect(() => {
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [handleMessage])
}
