/**
 * The pages the export's hidden web view runs (`use-export-renderer.ts`), and what they
 * post back. The phone's print engine (`expo-print`: a WKWebView printed as soon as its
 * page has loaded) does not wait for script, so anything drawn by script is drawn here
 * first, and the export prints or saves the static result:
 *
 * - `mermaidSvgPage`: draws a mermaid source with desktop's mermaid build and export
 *   options (light theme, dagre, strict), and posts the diagram as static SVG, sized to
 *   its own box (`width`/`height` from its viewBox, shrinking to fit a page).
 * - `pngCapturePage`: the shared PNG document of an SVG (`buildPngHtml`) plus a script
 *   that draws the SVG onto a `<canvas>` at 2x on white and posts the PNG's bytes.
 *   WebKit refuses to read back a canvas an SVG with HTML in it (`<foreignObject>`, as
 *   mermaid's labels are) was drawn on: that is the `tainted` error, and the export
 *   draws the diagram again with SVG text labels.
 *
 * - `htmlSnapshotPage`: an html artifact as the shared document renders it, its own
 *   scripts on, plus ours: once the page has loaded and its DOM has gone quiet (charts
 *   drawn), it posts a copy of the DOM made inert — scripts and `<meta refresh>` out,
 *   frames sandboxed, each readable `<canvas>` as the picture it holds, style rules
 *   added by script kept. The export prints that copy (`htmlPrintDocument`) with no
 *   script at all, so expo-print's web view (no navigation policy, no cancel) never
 *   runs the artifact; the artifact runs only here, where a page that loops is unmounted
 *   at the renderer's timeout.
 *
 * The mermaid and PNG pages run only their own scripts (a nonce'd policy, as the
 * viewer's pages): a script inside an artifact's SVG never runs. Every page has a token
 * of its own that its replies carry; a message without it is not a reply
 * (`parseExportRenderReply`), so an html artifact's scripts, which run beside ours and
 * never see the token, cannot answer for the page.
 */
import { mermaidInitOptions } from '@slayzone/markdown/mermaid-config'
import { buildDocumentHtml, buildPngHtml } from '@slayzone/task-artifacts/export-html'
import { contentPolicy, inlineScript, newNonce, pageShell } from '../pages/page-style'

/** Marks the replies of these pages among anything else a page could post. */
export const EXPORT_RENDER_SOURCE = 'slayzone-export'

/** A page for the hidden web view: its HTML and the token its replies carry. */
export interface ExportRenderPage {
  html: string
  token: string
  /** The web view's size in points while it renders (default: the renderer's own). */
  viewport?: { width: number; height: number }
}

export type ExportRenderErrorCode = 'render' | 'tainted'

export type ExportRenderReply =
  /** The drawn diagram (`mermaidSvgPage`). */
  | { type: 'svg'; svg: string }
  /** The PNG's bytes, base64, and its size in pixels (`pngCapturePage`). */
  | { type: 'png'; base64: string; width: number; height: number }
  /** The html artifact's DOM as drawn, inert (`htmlSnapshotPage`). */
  | { type: 'html'; html: string }
  /** `render`: nothing could be drawn (`message` says why); `tainted`: see above. */
  | { type: 'error'; code: ExportRenderErrorCode; message: string }

/** A fresh token: three nonces, so no page can guess another's. */
const newToken = (): string => `${newNonce()}${newNonce()}${newNonce()}`

/** A value as script source, safe inside an inline `<script>`. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * The pages' way back to the app: `post(reply)`, `messageOf(error)`. Everything `post`
 * uses is taken when the helpers run (first, in the html page), and the message is
 * written by hand, the token never set on or serialized with an object: a script that
 * runs later and replaces the bridge, `String`, `JSON`, or adds setters or `toJSON` to
 * `Object.prototype`, never sees the token. On iOS the reply goes straight to
 * react-native-webview's message handler (`ReactNativeWebView`), which its own
 * `window.ReactNativeWebView.postMessage` reaches through `String(data)`.
 */
function replyHelpers(token: string): string {
  const head = `{"source":${JSON.stringify(EXPORT_RENDER_SOURCE)},"token":${JSON.stringify(token)}`
  return `
  var __apply = Reflect.apply;
  var __stringify = JSON.stringify;
  var __keys = Object.keys;
  var __handlers = window.webkit && window.webkit.messageHandlers;
  var __bridge = (__handlers && __handlers.ReactNativeWebView) || window.ReactNativeWebView;
  var __send = __bridge.postMessage;
  var __head = ${scriptJson(head)};
  function post(reply) {
    // Each value is a string or a number: serialized as itself, no method of the page's.
    var keys = __keys(reply), message = __head;
    for (var i = 0; i < keys.length; i++) {
      message += ',' + __stringify(keys[i]) + ':' + __stringify(reply[keys[i]]);
    }
    __apply(__send, __bridge, [message + '}']);
  }
  function messageOf(error) {
    return error && error.message ? '' + error.message : '' + error;
  }`
}

export function mermaidSvgPage(
  source: string,
  mermaidScript: string,
  options: { htmlLabels: boolean }
): ExportRenderPage {
  const nonce = newNonce()
  const token = newToken()
  const init = { ...mermaidInitOptions('light'), htmlLabels: options.htmlLabels }
  const draw = `(function () {${replyHelpers(token)}
  mermaid.initialize(${scriptJson(init)});
  mermaid.render('slz-export', ${scriptJson(source)}).then(function (result) {
    var host = document.getElementById('export-host');
    host.innerHTML = result.svg;
    var svg = host.querySelector('svg');
    if (!svg) {
      post({ type: 'error', code: 'render', message: 'mermaid drew nothing.' });
      return;
    }
    var box = svg.viewBox && svg.viewBox.baseVal;
    if (box && box.width && box.height) {
      svg.setAttribute('width', String(Math.ceil(box.width)));
      svg.setAttribute('height', String(Math.ceil(box.height)));
    }
    svg.style.maxWidth = '100%';
    svg.style.height = 'auto';
    post({ type: 'svg', svg: svg.outerHTML });
  }, function (error) {
    post({ type: 'error', code: 'render', message: messageOf(error) });
  });
})();`
  const html = pageShell({
    policy: contentPolicy(nonce),
    css: 'body { margin: 0; }',
    body: '<div id="export-host"></div>',
    scripts: inlineScript(nonce, mermaidScript) + inlineScript(nonce, draw)
  })
  return { html, token }
}

/**
 * iOS refuses a canvas over 16.7M pixels (4096²) and hands back an empty image; the
 * scale drops below 2x to stay under it.
 */
const MAX_CANVAS_PIXELS = 16_000_000

const captureScript = (token: string): string => `(function () {${replyHelpers(token)}
  function length(value) {
    return value && /^\\s*\\d+(\\.\\d+)?(px)?\\s*$/.test(value) ? parseFloat(value) : 0;
  }
  var svg = document.querySelector('svg');
  if (!svg) {
    post({ type: 'error', code: 'render', message: 'There is no SVG to draw.' });
    return;
  }
  // Its own size: width/height in pixels, else its viewBox's, else its laid-out box.
  var w = length(svg.getAttribute('width'));
  var h = length(svg.getAttribute('height'));
  var box = svg.viewBox && svg.viewBox.baseVal;
  if ((!w || !h) && box && box.width && box.height) {
    if (w) h = (w * box.height) / box.width;
    else if (h) w = (h * box.width) / box.height;
    else { w = box.width; h = box.height; }
  }
  if (!w || !h) {
    var rect = svg.getBoundingClientRect();
    w = rect.width;
    h = rect.height;
  }
  w = Math.max(Math.ceil(w), 10);
  h = Math.max(Math.ceil(h), 10);
  var scale = Math.min(2, Math.sqrt(${MAX_CANVAS_PIXELS} / (w * h)));
  var clone = svg.cloneNode(true);
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  clone.style.maxWidth = 'none';
  clone.style.height = '';
  var xml = new XMLSerializer().serializeToString(clone);
  var image = new Image();
  image.onload = function () {
    var canvas = document.createElement('canvas');
    canvas.width = Math.floor(w * scale);
    canvas.height = Math.floor(h * scale);
    var context = canvas.getContext('2d');
    context.scale(scale, scale);
    context.fillStyle = 'white';
    context.fillRect(0, 0, w, h);
    context.drawImage(image, 0, 0, w, h);
    var url;
    try {
      url = canvas.toDataURL('image/png');
    } catch (error) {
      post({ type: 'error', code: 'tainted', message: messageOf(error) });
      return;
    }
    var prefix = 'data:image/png;base64,';
    if (url.indexOf(prefix) !== 0 || url.length === prefix.length) {
      post({ type: 'error', code: 'render', message: 'The drawing is too large for a PNG.' });
      return;
    }
    post({ type: 'png', base64: url.slice(prefix.length), width: canvas.width, height: canvas.height });
  };
  image.onerror = function () {
    post({ type: 'error', code: 'render', message: "The SVG couldn't be drawn." });
  };
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
})();`

export function pngCapturePage(svg: string, title: string): ExportRenderPage {
  // The shared document's own policy allows only scripts carrying this nonce: the
  // capture script below carries it.
  const nonce = newNonce()
  const token = newToken()
  const html = buildPngHtml(svg, 'svg-preview', title, null, { nonce })
  if (html === null) throw new Error('pngCapturePage: no PNG document for an SVG')
  const policy = contentPolicy(nonce).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`
  // The document's own head and its last `</body>`: the SVG inside can hold anything.
  const withPolicy = html.replace('<head>', () => `<head>${meta}`)
  const end = withPolicy.lastIndexOf('</body>')
  return {
    html: `${withPolicy.slice(0, end)}${inlineScript(nonce, captureScript(token))}${withPolicy.slice(end)}`,
    token
  }
}

/**
 * How long an html artifact may take: it is taken once loaded and at least
 * `minAfterLoadMs` on (a chart's draw-in animation) with its DOM unchanged for
 * `quietMs`; and anyway `maxAfterLoadMs` after load (a page that keeps changing, a
 * clock) or `maxLoadMs` after it started (a request that never ends). All of it well
 * inside the renderer's own timeout, which ends a page whose script never yields.
 */
export const HTML_SETTLE = {
  tickMs: 100,
  quietMs: 500,
  minAfterLoadMs: 1000,
  maxAfterLoadMs: 5000,
  maxLoadMs: 15_000
} as const

/** A4 in points: the html artifact lays out at the width it prints at. */
const PRINT_PAGE = { width: 595, height: 842 }

/**
 * The snapshot script (see the header). It runs first in the page and takes out its
 * own element at once, so the token never is in the DOM the artifact's scripts see;
 * the DOM functions it makes the copy inert with are taken then too.
 */
const snapshotScript = (token: string): string => `(function () {
  var doc = document;
  if (doc.currentScript) doc.currentScript.remove();${replyHelpers(token)}
  var now = Date.now;
  var wait = setTimeout;
  var rootOf = Object.getOwnPropertyDescriptor(Document.prototype, 'documentElement').get;
  var serialize = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML').get;
  var countOf = Object.getOwnPropertyDescriptor(NodeList.prototype, 'length').get;
  var cloneNode = Node.prototype.cloneNode;
  var select = Element.prototype.querySelectorAll;
  var removeNode = Element.prototype.remove;
  var setAttr = Element.prototype.setAttribute;
  var getAttr = Element.prototype.getAttribute;
  var trim = String.prototype.trim;
  var lower = String.prototype.toLowerCase;
  var S = ${scriptJson(HTML_SETTLE)};

  // A static list of the matches and its length (no Array method: the page may own them).
  function all(root, selector) {
    var list = __apply(select, root, [selector]);
    return { list: list, length: __apply(countOf, list, []) };
  }

  // Script-drawn content the DOM doesn't hold: canvas pixels, CSSOM rules.
  function keepDrawn(live, copy) {
    var canvases = all(live, 'canvas'), copies = all(copy, 'canvas');
    var kept = ['id', 'class', 'width', 'height'];
    for (var i = 0; i < canvases.length && i < copies.length; i++) {
      var canvas = copies.list[i], url;
      try { url = canvases.list[i].toDataURL('image/png'); } catch (e) { continue; }
      if (typeof url !== 'string' || url.indexOf('data:image/') !== 0) continue;
      var img = doc.createElement('img');
      for (var a = 0; a < kept.length; a++) {
        var value = __apply(getAttr, canvas, [kept[a]]);
        if (value !== null) __apply(setAttr, img, [kept[a], value]);
      }
      // Its size as laid out, shrunk to fit the printed page's width.
      var style = __apply(getAttr, canvas, ['style']);
      __apply(setAttr, img, ['style', (style ? style.replace(/;?\\s*$/, ';') : '') + 'max-width:100%;height:auto']);
      __apply(setAttr, img, ['src', url]);
      canvas.replaceWith(img);
    }
    var styles = all(live, 'style'), styleCopies = all(copy, 'style');
    for (var j = 0; j < styles.length && j < styleCopies.length; j++) {
      try {
        var rules = styles.list[j].sheet && styles.list[j].sheet.cssRules;
        if (!rules) continue;
        var css = '';
        for (var k = 0; k < rules.length; k++) css += rules[k].cssText + '\\n';
        styleCopies.list[j].textContent = css;
      } catch (e) {}
    }
    var fields = all(live, 'input'), fieldCopies = all(copy, 'input');
    for (var f = 0; f < fields.length && f < fieldCopies.length; f++) {
      try {
        var field = fields.list[f], fieldCopy = fieldCopies.list[f];
        if (field.type === 'checkbox' || field.type === 'radio') {
          if (field.checked) __apply(setAttr, fieldCopy, ['checked', '']);
          else fieldCopy.removeAttribute('checked');
        } else if (field.type !== 'file' && field.type !== 'password') {
          __apply(setAttr, fieldCopy, ['value', field.value]);
        }
      } catch (e) {}
    }
    var adopted = doc.adoptedStyleSheets;
    var head = all(copy, 'head').list[0];
    if (adopted && head) {
      for (var s = 0; s < adopted.length; s++) {
        try {
          var sheetCss = '';
          for (var r = 0; r < adopted[s].cssRules.length; r++) sheetCss += adopted[s].cssRules[r].cssText + '\\n';
          var adoptedStyle = doc.createElement('style');
          adoptedStyle.textContent = sheetCss;
          head.append(adoptedStyle);
        } catch (e) {}
      }
    }
  }

  // Inert: nothing in the copy can run or navigate (the print's policy blocks scripts too).
  function makeInert(copy) {
    var scripts = all(copy, 'script');
    for (var i = 0; i < scripts.length; i++) __apply(removeNode, scripts.list[i], []);
    var metas = all(copy, 'meta');
    for (var j = 0; j < metas.length; j++) {
      var equiv = __apply(getAttr, metas.list[j], ['http-equiv']);
      if (equiv !== null && __apply(lower, __apply(trim, equiv, []), []) === 'refresh') {
        __apply(removeNode, metas.list[j], []);
      }
    }
    var frames = all(copy, 'iframe');
    for (var k = 0; k < frames.length; k++) __apply(setAttr, frames.list[k], ['sandbox', '']);
  }

  function snapshot() {
    var live = __apply(rootOf, doc, []);
    var copy = __apply(cloneNode, live, [true]);
    try { keepDrawn(live, copy); } catch (e) {}
    makeInert(copy);
    return __apply(serialize, copy, []);
  }

  var started = now(), loadedAt = 0, changedAt = started;
  var observer = new MutationObserver(function () { changedAt = now(); });
  observer.observe(doc, { childList: true, subtree: true, attributes: true, characterData: true });
  window.addEventListener('load', function () { loadedAt = now(); });

  function settled(t) {
    if (!loadedAt) return t - started >= S.maxLoadMs;
    var since = t - loadedAt;
    return since >= S.maxAfterLoadMs || (since >= S.minAfterLoadMs && t - changedAt >= S.quietMs);
  }

  (function tick() {
    if (!settled(now())) { wait(tick, S.tickMs); return; }
    try { observer.disconnect(); } catch (e) {}
    var html;
    try { html = snapshot(); } catch (error) {
      post({ type: 'error', code: 'render', message: messageOf(error) });
      return;
    }
    post({ type: 'html', html: html });
  })();
})();`

/**
 * An html artifact's render page: the shared document (`buildDocumentHtml`, no policy:
 * the artifact runs as it does in the viewer), with the snapshot script first in its
 * head, laid out at the printed page's size.
 */
export function htmlSnapshotPage(content: string, title: string): ExportRenderPage {
  const token = newToken()
  const html = buildDocumentHtml(content, 'html-preview', title)
  const at = html.indexOf('<head>')
  if (at === -1) throw new Error('htmlSnapshotPage: the document has no head')
  const script = snapshotScript(token)
  if (/<\/?script/i.test(script)) throw new Error('htmlSnapshotPage: the script holds a script tag')
  const head = at + '<head>'.length
  return {
    html: `${html.slice(0, head)}<script>${script}</script>${html.slice(head)}`,
    token,
    viewport: PRINT_PAGE
  }
}

/**
 * The print's policy: no script, no plugin. Styles, images and fonts load as they did
 * in the render (an artifact's stylesheet from a CDN included).
 */
export const HTML_PRINT_POLICY = "script-src 'none'; object-src 'none'"

/**
 * The document expo-print prints for an html artifact: its snapshot, behind a policy
 * that blocks every script. The policy goes BEFORE the snapshot's `<html>`: the HTML
 * parser opens the head for it there and folds the snapshot's own `<html>`/`<head>` into
 * those, so it is always the head's first element whatever the snapshot holds.
 */
export function htmlPrintDocument(snapshot: string): string {
  return `<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="${HTML_PRINT_POLICY}">${snapshot}`
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A reply of the page with `token`, or null for anything else. */
export function parseExportRenderReply(data: string, token: string): ExportRenderReply | null {
  let raw: unknown
  try {
    raw = JSON.parse(data)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.source !== EXPORT_RENDER_SOURCE || typeof r.token !== 'string' || r.token !== token) {
    return null
  }
  switch (r.type) {
    case 'svg':
      return typeof r.svg === 'string' ? { type: 'svg', svg: r.svg } : null
    case 'png':
      return typeof r.base64 === 'string' && isNumber(r.width) && isNumber(r.height)
        ? { type: 'png', base64: r.base64, width: r.width, height: r.height }
        : null
    case 'html':
      return typeof r.html === 'string' ? { type: 'html', html: r.html } : null
    case 'error':
      return (r.code === 'render' || r.code === 'tainted') && typeof r.message === 'string'
        ? { type: 'error', code: r.code, message: r.message }
        : null
    default:
      return null
  }
}
