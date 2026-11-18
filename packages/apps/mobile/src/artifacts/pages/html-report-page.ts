/**
 * An HTML artifact (a report) as a page, under desktop's limits: desktop shows it in an
 * `<iframe sandbox="allow-scripts">` — its scripts run (inline and from the web), it may
 * load anything from the web, and nothing else: no forms, popups, dialogs, top-level
 * navigation, or storage of a real origin. The phone does exactly that: the web view
 * loads a small host page whose only content is that same iframe, the report as its
 * `srcdoc`. The host sets no content policy (desktop sets none; a srcdoc frame would
 * inherit it).
 *
 * Links: the report gets desktop's link bridge (`buildHtmlPreviewLinkBridgeScript`): a
 * tap on an http(s)/mailto link it doesn't handle itself posts the URL to the host, which
 * passes it to the app — only while the tap is fresh (`navigator.userActivation`), as
 * desktop's receiver checks — and the app opens it outside (desktop: a bare click opens
 * externally). Other links navigate inside the frame, as on desktop.
 *
 * The host's check is the only thing between the report and the app, and WKWebView gives
 * its message handler to every frame: the report could post to the app straight,
 * skipping it. So the host signs what it forwards with the page's token (a fresh secret
 * per page, only in the host's script — the frame is of another origin and can't read
 * it), and the app drops every message without it (`DocumentWebView`).
 *
 * Theme: a colour scheme the artifact forces (`html_theme_override`) is injected the way
 * desktop serves it (`injectForcedHtmlTheme`); otherwise the app's own (desktop: the
 * frame follows the app's theme, which sets the window's scheme).
 */
import { type ForcedHtmlTheme, injectForcedHtmlTheme } from '@slayzone/platform/forced-html-theme'
import {
  buildHtmlPreviewLinkBridgeScript,
  HTML_PREVIEW_LINK_MESSAGE_TYPE
} from '@slayzone/platform/html-preview-links'
import { newToken } from './page-style'

const HEAD_OPEN = /<head(?:\s[^>]*)?>/i
const HTML_OPEN = /<html(?:\s[^>]*)?>/i
const DOCTYPE = /^\s*<!doctype[^>]*>/i

/**
 * `markup` placed first in the document's head: after `<head>`, else after `<html>`,
 * else after the doctype (before it would switch the page to quirks mode), else first.
 */
export function insertIntoHead(html: string, markup: string): string {
  const at = HEAD_OPEN.exec(html) ?? HTML_OPEN.exec(html) ?? DOCTYPE.exec(html)
  if (!at) return markup + html
  const end = at.index + at[0].length
  return html.slice(0, end) + markup + html.slice(end)
}

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

/** The host's only script: forward the report frame's link messages to the app, signed with `token`. */
const hostScript = (token: string): string => `(function () {
  var token = ${JSON.stringify(token)};
  var frame = document.querySelector('iframe');
  window.addEventListener('message', function (e) {
    if (e.source !== frame.contentWindow) return;
    var d = e.data;
    if (!d || d.type !== ${JSON.stringify(HTML_PREVIEW_LINK_MESSAGE_TYPE)} || typeof d.url !== 'string') return;
    if (navigator.userActivation && !navigator.userActivation.isActive) return;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: d.type, url: d.url, metaKey: d.metaKey === true,
      ctrlKey: d.ctrlKey === true, shiftKey: d.shiftKey === true, token: token }));
  });
})();`

export interface HtmlReportPage {
  html: string
  /** What the host's messages carry; the app drops a message without it. */
  token: string
}

/** `forcedTheme`: the artifact's own scheme, else the app's variant. */
export function htmlReportPage(
  report: string,
  options: { forcedTheme: ForcedHtmlTheme | null }
): HtmlReportPage {
  const themed = options.forcedTheme ? injectForcedHtmlTheme(report, options.forcedTheme) : report
  const framed = insertIntoHead(themed, `<script>${buildHtmlPreviewLinkBridgeScript()}</script>`)
  const token = newToken()
  const html = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=8">',
    '<style>html, body { margin: 0; height: 100%; } iframe { display: block; border: 0; width: 100%; height: 100%; }</style>',
    '</head><body>',
    `<iframe sandbox="allow-scripts" title="HTML preview" srcdoc="${escapeAttribute(framed)}"></iframe>`,
    `<script>${hostScript(token)}</script>`,
    '</body></html>'
  ].join('')
  return { html, token }
}
