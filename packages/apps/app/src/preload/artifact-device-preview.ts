import { ipcRenderer } from 'electron'
import {
  HTML_PREVIEW_LINK_MESSAGE_TYPE,
  parseHtmlPreviewLinkMessage
} from '@slayzone/platform/html-preview-links'
import { SLZ_ARTIFACT_SCHEME } from '@slayzone/platform/slz-file-url'

if (process.isMainFrame && location.protocol === `${SLZ_ARTIFACT_SCHEME}:`) {
  // Runs in the guest's isolated world. Only a real link click can reach the
  // embedder; the artifact page has no access to this IPC channel.
  const openLink = (event: MouseEvent) => {
    if (!event.isTrusted || event.defaultPrevented) return
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!anchor) return
    let url: string
    try {
      url = new URL(anchor.getAttribute('href') ?? '', document.baseURI).href
    } catch {
      return
    }
    const middleClick = event.button === 1
    const message = parseHtmlPreviewLinkMessage({
      type: HTML_PREVIEW_LINK_MESSAGE_TYPE,
      url,
      metaKey: middleClick || event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: !middleClick && event.shiftKey
    })
    if (!message) return
    event.preventDefault()
    ipcRenderer.sendToHost(HTML_PREVIEW_LINK_MESSAGE_TYPE, message)
  }
  window.addEventListener(
    'DOMContentLoaded',
    () => {
      window.addEventListener('click', (event) => {
        if (event.button === 0) openLink(event)
      })
      window.addEventListener('auxclick', (event) => {
        if (event.button === 1) openLink(event)
      })
    },
    { once: true }
  )
}
