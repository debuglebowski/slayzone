/**
 * Link clicks inside PDF artifacts.
 *
 * PDF artifacts render in Chromium's built-in PDF viewer (a component
 * extension frame nested in the artifact's `<iframe>`). Clicks on PDF links are
 * handled by pdfium, never by the DOM, and the viewer turns them into
 * `chrome.tabs.*` calls — which Electron only partly implements:
 *
 *   ⌘ click   → chrome.tabs.create({ url, active: false })  — missing → TypeError, click lost
 *   ⌘⇧ click  → chrome.tabs.create({ url, active: true })   — missing → TypeError, click lost
 *   bare click → chrome.tabs.update(tabId, { url })          — navigates the WHOLE app window
 *   ⇧ click   → window.open(url)                             — reaches setWindowOpenHandler
 *
 * Main injects `buildPdfViewerLinkBridgeScript()` into every viewer frame of an
 * app window: it replaces both calls with a `postMessage` to the app renderer
 * (`window.top`), which routes the link with the app-wide modifier convention
 * (see `resolvePdfLinkAction`; renderer side: `usePdfViewerLinks` in @slayzone/editor).
 */

/** Origin of Chromium's built-in PDF viewer component extension (fixed id). */
export const PDF_VIEWER_EXTENSION_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai'

export const PDF_VIEWER_LINK_MESSAGE_TYPE = 'slayzone:pdf-viewer-link'

/** The viewer's own disposition for the click, named after the tab it asked for. */
export type PdfLinkIntent = 'current-tab' | 'background-tab' | 'foreground-tab'

export interface PdfViewerLinkMessage {
  type: typeof PDF_VIEWER_LINK_MESSAGE_TYPE
  intent: PdfLinkIntent
  url: string
}

const INTENTS: ReadonlySet<string> = new Set<PdfLinkIntent>([
  'current-tab',
  'background-tab',
  'foreground-tab'
])

/** Validates a `message` event payload; only http(s) links are ever routed. */
export function parsePdfViewerLinkMessage(data: unknown): PdfViewerLinkMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const { type, intent, url } = data as Record<string, unknown>
  if (type !== PDF_VIEWER_LINK_MESSAGE_TYPE) return null
  if (typeof intent !== 'string' || !INTENTS.has(intent)) return null
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null
  return { type, intent: intent as PdfLinkIntent, url }
}

/**
 * Same convention as terminal and chat links:
 *   ⌘ click (background tab)  → the task's in-app browser
 *   ⌘⇧ click (foreground tab) → external browser
 *   bare click (current tab)  → external browser (never navigate the app window)
 */
export function resolvePdfLinkAction(intent: PdfLinkIntent): 'in-app-browser' | 'external' {
  return intent === 'background-tab' ? 'in-app-browser' : 'external'
}

const PDF_VIEWER_LINK_BRIDGE_SCRIPT_TEMPLATE = `
(() => {
  const installedKey = '__slzPdfViewerLinkBridge';
  if (window[installedKey]) return 'already-installed';
  const tabs = window.chrome && window.chrome.tabs;
  if (!tabs) return 'no-tabs-api';
  const post = (intent, url) => {
    if (typeof url !== 'string') return;
    window.top.postMessage({ type: __SLZ_TYPE__, intent: intent, url: url }, '*');
  };
  tabs.create = (props) => {
    post(props && props.active === false ? 'background-tab' : 'foreground-tab', props && props.url);
    return Promise.resolve(undefined);
  };
  const update = typeof tabs.update === 'function' ? tabs.update.bind(tabs) : null;
  tabs.update = (...args) => {
    const props = typeof args[0] === 'object' && args[0] !== null ? args[0] : args[1];
    if (props && typeof props.url === 'string') {
      post('current-tab', props.url);
      return Promise.resolve(undefined);
    }
    return update ? update(...args) : Promise.resolve(undefined);
  };
  window[installedKey] = true;
  return 'installed';
})()
`

/** Script for `WebFrameMain.executeJavaScript` on a PDF viewer frame. Idempotent. */
export function buildPdfViewerLinkBridgeScript(): string {
  return PDF_VIEWER_LINK_BRIDGE_SCRIPT_TEMPLATE.replace(
    '__SLZ_TYPE__',
    JSON.stringify(PDF_VIEWER_LINK_MESSAGE_TYPE)
  )
}
