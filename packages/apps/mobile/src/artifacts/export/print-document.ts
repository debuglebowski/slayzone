/**
 * What expo-print is handed for a markdown, code, svg or mermaid PDF. Its WKWebView has
 * no navigation policy (expo-print 58, `ExpoWKPDFRenderer.swift`: `loadHTMLString`, a
 * navigation delegate that only waits for `didFinish` and prints), so whatever its HTML
 * parser sees can navigate it: a `<meta http-equiv=refresh>` anywhere in the document (a
 * content policy governs what a page fetches, not where it goes), a `<base>`. The PDF
 * would be another page, or nothing.
 *
 * So its parser never sees the document: `printDocument(document)` is a page of our own —
 * the shared documents' policy, its one script allowed by a fresh nonce — that carries the
 * document as a string. The script parses it with `DOMParser` (no browsing context:
 * nothing in it loads, runs or navigates), removes what navigates or runs (`meta`,
 * `base`, `script`; frames are sandboxed, though the policy blocks them anyway), and moves
 * the nodes in. Nodes, never markup: nothing is serialized and parsed again, so nothing
 * can re-parse into something else. A declarative shadow root (inert to `DOMParser`) is
 * attached as the live parser would have. It all happens while the page loads, before
 * expo-print prints (on `didFinish`): pictures moved in delay the load as they always did.
 *
 * Text stays text: the PDF's text can be selected and searched, as on desktop. (An html
 * artifact's PDF is page pictures instead: `htmlPrintDocument`.)
 */
import { exportDocumentPolicy } from '@slayzone/task-artifacts/export-html'
import { inlineScript, newNonce } from '../pages/page-style'
import { scriptJson } from './render-pages'

/** Elements that navigate, re-point URLs or run: never moved into the printed page. */
const REMOVED = ['meta', 'base', 'script'] as const

const transplantScript = (html: string): string => `(function () {
  var doc = document;
  var parsed = new DOMParser().parseFromString(${scriptJson(html)}, 'text/html');
  var REMOVED = ${scriptJson(REMOVED.join(','))};

  // Removes what navigates or runs, in template contents too; sandboxes each frame.
  function clean(root) {
    var found = root.querySelectorAll(REMOVED);
    for (var i = 0; i < found.length; i++) found[i].remove();
    var frames = root.querySelectorAll('iframe, frame');
    for (var f = 0; f < frames.length; f++) frames[f].setAttribute('sandbox', '');
    var templates = root.querySelectorAll('template');
    for (var t = 0; t < templates.length; t++) clean(templates[t].content);
  }

  // \`<template shadowrootmode>\`: attached as a shadow root of its parent, innermost first.
  function attachShadowRoots(root) {
    var templates = root.querySelectorAll('template'), list = [];
    for (var i = 0; i < templates.length; i++) list.push(templates[i]);
    for (var j = list.length - 1; j >= 0; j--) {
      var template = list[j];
      attachShadowRoots(template.content);
      var mode = template.getAttribute('shadowrootmode');
      var host = template.parentNode;
      if ((mode !== 'open' && mode !== 'closed') || !host || host.nodeType !== 1 || host.shadowRoot) continue;
      try {
        var shadow = host.attachShadow({ mode: mode });
        shadow.appendChild(template.content);
        template.remove();
      } catch (error) {}
    }
  }

  clean(parsed);
  attachShadowRoots(parsed);
  var root = parsed.documentElement;
  for (var a = 0; a < root.attributes.length; a++) {
    // The parser keeps names no DOM call can set (\`<html =x>\`): those are skipped.
    try { doc.documentElement.setAttribute(root.attributes[a].name, root.attributes[a].value); } catch (error) {}
  }
  var body = parsed.body;
  for (var b = 0; body && b < body.attributes.length; b++) {
    try { doc.body.setAttribute(body.attributes[b].name, body.attributes[b].value); } catch (error) {}
  }
  if (parsed.head) while (parsed.head.firstChild) doc.head.appendChild(parsed.head.firstChild);
  var script = doc.currentScript;
  if (body) while (body.firstChild) doc.body.appendChild(body.firstChild);
  if (script) script.remove();
})();`

/** The page expo-print prints for `html` (a shared export document): see above. */
export function printDocument(html: string): string {
  const nonce = newNonce()
  const policy = exportDocumentPolicy(nonce).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    '</head><body>',
    inlineScript(nonce, transplantScript(html)),
    '</body></html>'
  ].join('')
}
