/**
 * Link clicks inside HTML artifact previews.
 *
 * HTML artifacts render in an `<iframe sandbox="allow-scripts">` served over
 * `slz-file://`. The parent can't reach the cross-origin document, and the
 * sandbox (no `allow-popups`) changes what a click on a link does:
 *
 *   target=_blank / ⌘ click / middle click → popup blocked by the sandbox, click lost
 *   bare click                             → navigates the PREVIEW itself to the site
 *                                            (usually refused by X-Frame-Options → blank pane)
 *
 * Main injects `buildHtmlPreviewLinkBridgeScript()` into every slz-file frame of
 * an app window: a bubble-phase click listener that, for http(s)/mailto links the
 * page itself didn't handle, cancels the navigation and posts the URL + modifiers
 * to the app renderer (`window.top`). The renderer routes it with the read-only
 * link convention (`resolveReadOnlyLinkClickTarget`; renderer side:
 * `useHtmlPreviewLinks` in @slayzone/editor). Hash and relative links keep
 * navigating inside the preview.
 *
 * The page runs untrusted script and can post the same message itself, so the
 * renderer only honors one while it holds transient user activation (a click
 * inside the iframe activates its ancestors too).
 */

import { SLZ_FILE_PREFIX } from './slz-file-url'

export const HTML_PREVIEW_LINK_MESSAGE_TYPE = 'slayzone:html-preview-link'

export interface HtmlPreviewLinkMessage {
  type: typeof HTML_PREVIEW_LINK_MESSAGE_TYPE
  url: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

const OPENABLE_URL = /^(https?:\/\/|mailto:)/i

/** Validates a `message` event payload; only http(s) and mailto links are ever routed. */
export function parseHtmlPreviewLinkMessage(data: unknown): HtmlPreviewLinkMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const { type, url, metaKey, ctrlKey, shiftKey } = data as Record<string, unknown>
  if (type !== HTML_PREVIEW_LINK_MESSAGE_TYPE) return null
  if (typeof url !== 'string' || !OPENABLE_URL.test(url)) return null
  if (typeof metaKey !== 'boolean' || typeof ctrlKey !== 'boolean') return null
  if (typeof shiftKey !== 'boolean') return null
  return { type, url, metaKey, ctrlKey, shiftKey }
}

/** Frames that get the bridge: slz-file documents, minus PDFs (their own bridge). */
export function isHtmlPreviewFrameUrl(url: string): boolean {
  if (!url.startsWith(SLZ_FILE_PREFIX)) return false
  const path = url.split(/[?#]/, 1)[0]
  return !/\.pdf$/i.test(path)
}

const HTML_PREVIEW_LINK_BRIDGE_SCRIPT_TEMPLATE = `
(() => {
  const installedKey = '__slzHtmlPreviewLinkBridge';
  if (window[installedKey]) return 'already-installed';
  const openable = /^(https?:\\/\\/|mailto:)/i;
  const relay = (e, background) => {
    if (e.defaultPrevented) return;
    const target = e.target;
    const anchor = target && typeof target.closest === 'function' ? target.closest('a[href]') : null;
    if (!anchor) return;
    let url;
    try { url = new URL(anchor.getAttribute('href'), document.baseURI).href; } catch { return; }
    if (!openable.test(url)) return;
    e.preventDefault();
    window.top.postMessage({
      type: __SLZ_TYPE__,
      url: url,
      metaKey: background || !!e.metaKey,
      ctrlKey: !!e.ctrlKey,
      shiftKey: !background && !!e.shiftKey
    }, '*');
  };
  window.addEventListener('click', (e) => { if (e.button === 0) relay(e, false); });
  window.addEventListener('auxclick', (e) => { if (e.button === 1) relay(e, true); });
  window[installedKey] = true;
  return 'installed';
})()
`

/** Script for `WebFrameMain.executeJavaScript` on an HTML preview frame. Idempotent. */
export function buildHtmlPreviewLinkBridgeScript(): string {
  return HTML_PREVIEW_LINK_BRIDGE_SCRIPT_TEMPLATE.replace(
    '__SLZ_TYPE__',
    JSON.stringify(HTML_PREVIEW_LINK_MESSAGE_TYPE)
  )
}
