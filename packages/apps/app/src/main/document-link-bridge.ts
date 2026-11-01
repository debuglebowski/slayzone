import type { WebContents, WebFrameMain } from 'electron'
import { matchesElectronInput } from '@slayzone/shortcuts'
import {
  PDF_VIEWER_EXTENSION_ORIGIN,
  buildPdfViewerLinkBridgeScript
} from '@slayzone/platform/pdf-viewer-links'
import {
  buildHtmlPreviewLinkBridgeScript,
  isHtmlPreviewFrameUrl
} from '@slayzone/platform/html-preview-links'

const PDF_BRIDGE_SCRIPT = buildPdfViewerLinkBridgeScript()
const HTML_BRIDGE_SCRIPT = buildHtmlPreviewLinkBridgeScript()

let getDocumentShortcutKeys: () => (string | null)[] = () => []

/** The host supplies live keys so open previews follow shortcut customization. */
export function setDocumentShortcutKeysResolver(resolve: () => (string | null)[]): void {
  getDocumentShortcutKeys = resolve
}

/**
 * Make links in PDF and HTML artifacts clickable in an app window (see
 * `pdf-viewer-links.ts` / `html-preview-links.ts` for why each drops them
 * otherwise). App windows only: in a browser-panel view `window.top` is a
 * website, which must never learn what the user clicked in a document.
 */
export function attachDocumentLinkBridges(wc: WebContents): void {
  // Frame key events never bubble into the app DOM. Relay only opted-in app
  // shortcuts from document previews, directly to this window's renderer; no
  // broadcast to other task windows and no untrusted postMessage command channel.
  wc.on('before-input-event', (event, input) => {
    if (wc.isDestroyed()) return
    const frame = wc.focusedFrame
    if (!frame || frame === wc.mainFrame) return
    if (frame.origin !== PDF_VIEWER_EXTENSION_ORIGIN && !isHtmlPreviewFrameUrl(frame.url)) return
    if (!getDocumentShortcutKeys().some((keys) => matchesElectronInput(input, keys))) return
    event.preventDefault()
    const init = {
      key: input.key,
      code: input.code,
      metaKey: input.meta,
      ctrlKey: input.control,
      shiftKey: input.shift,
      altKey: input.alt,
      bubbles: true,
      cancelable: true
    }
    wc.mainFrame
      .executeJavaScript(
        `document.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(init)}))`
      )
      .catch(() => {
        // Navigation or a window close can destroy the frame after the keypress.
      })
  })
  const inject = (frame: WebFrameMain): void => {
    if (wc.isDestroyed() || frame.isDestroyed()) return
    let script: string | null = null
    if (frame.origin === PDF_VIEWER_EXTENSION_ORIGIN) script = PDF_BRIDGE_SCRIPT
    else if (frame !== wc.mainFrame && isHtmlPreviewFrameUrl(frame.url)) script = HTML_BRIDGE_SCRIPT
    if (!script) return
    frame.executeJavaScript(script).catch(() => {
      // The artifact can be switched (frame torn down) between the scan and the
      // inject; the replacement frame's own load re-runs this.
    })
  }
  // dom-ready: links work before a slow page (CDN scripts, fonts) finishes
  // loading. did-frame-finish-load: the catch-all rescan (PDF viewer frames,
  // frames whose dom-ready raced the listener). The scripts are idempotent.
  wc.on('frame-created', (_event, { frame }) => {
    frame?.on('dom-ready', () => inject(frame))
  })
  wc.on('did-frame-finish-load', () => {
    if (wc.isDestroyed()) return
    for (const frame of wc.mainFrame.framesInSubtree) inject(frame)
  })
}
