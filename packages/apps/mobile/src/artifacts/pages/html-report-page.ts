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
 * Theme: a colour scheme the artifact forces (`html_theme_override`) is injected the way
 * desktop serves it (`injectForcedHtmlTheme`); otherwise the report follows the device.
 */
import { type ForcedHtmlTheme, injectForcedHtmlTheme } from '@slayzone/platform/forced-html-theme'
import {
  buildHtmlPreviewLinkBridgeScript,
  HTML_PREVIEW_LINK_MESSAGE_TYPE
} from '@slayzone/platform/html-preview-links'

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

/** The host's only script: forward the report frame's link messages to the app. */
const HOST_SCRIPT = `(function () {
  var frame = document.querySelector('iframe');
  window.addEventListener('message', function (e) {
    if (e.source !== frame.contentWindow) return;
    var d = e.data;
    if (!d || d.type !== ${JSON.stringify(HTML_PREVIEW_LINK_MESSAGE_TYPE)} || typeof d.url !== 'string') return;
    if (navigator.userActivation && !navigator.userActivation.isActive) return;
    window.ReactNativeWebView.postMessage(JSON.stringify(d));
  });
})();`

export function htmlReportPage(
  report: string,
  options: { forcedTheme: ForcedHtmlTheme | null }
): string {
  const themed = options.forcedTheme ? injectForcedHtmlTheme(report, options.forcedTheme) : report
  const framed = insertIntoHead(themed, `<script>${buildHtmlPreviewLinkBridgeScript()}</script>`)
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=8">',
    '<style>html, body { margin: 0; height: 100%; } iframe { display: block; border: 0; width: 100%; height: 100%; }</style>',
    '</head><body>',
    `<iframe sandbox="allow-scripts" title="HTML preview" srcdoc="${escapeAttribute(framed)}"></iframe>`,
    `<script>${HOST_SCRIPT}</script>`,
    '</body></html>'
  ].join('')
}
