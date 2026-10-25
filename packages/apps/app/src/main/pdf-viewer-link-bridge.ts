import type { WebContents } from 'electron'
import {
  PDF_VIEWER_EXTENSION_ORIGIN,
  buildPdfViewerLinkBridgeScript
} from '@slayzone/platform/pdf-viewer-links'

const BRIDGE_SCRIPT = buildPdfViewerLinkBridgeScript()

/**
 * Make links in PDF artifacts clickable with modifiers in an app window (see
 * `pdf-viewer-links.ts` for why Electron's viewer drops them). App windows
 * only: in a browser-panel view `window.top` is a website, which must never
 * learn what the user clicked in a PDF.
 */
export function attachPdfViewerLinkBridge(wc: WebContents): void {
  wc.on('did-frame-finish-load', () => {
    if (wc.isDestroyed()) return
    for (const frame of wc.mainFrame.framesInSubtree) {
      if (frame.origin !== PDF_VIEWER_EXTENSION_ORIGIN) continue
      frame.executeJavaScript(BRIDGE_SCRIPT).catch(() => {
        // The artifact can be switched (frame torn down) between the scan and the
        // inject; the replacement viewer's own load re-runs this.
      })
    }
  })
}
