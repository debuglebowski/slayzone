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
 * - `htmlRasterPage`: an html artifact, run as the viewer runs it — in an
 *   `<iframe sandbox="allow-scripts">` inside a host page of ours, so its dialogs never
 *   reach the app as native alerts — then drawn page by page as PNGs (html2canvas, in the host). The
 *   export prints only those pictures (`htmlPrintDocument`): nothing the artifact wrote
 *   is ever parsed by expo-print's web view (no navigation policy, no cancel). The
 *   artifact runs only here, where a page that loops is unmounted at the timeout.
 *
 * The mermaid and PNG pages run only their own scripts (a nonce'd policy, as the
 * viewer's pages): a script inside an artifact's SVG never runs. Every page has a token
 * of its own that its replies carry; a message without it is not a reply
 * (`parseExportRenderReply`). An html artifact never sees its page's token: it runs in a
 * frame of another origin, and the token is only in the host's script.
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
  /** How long it may take (default: the renderer's own). */
  timeoutMs?: number
}

export type ExportRenderErrorCode = 'render' | 'tainted'

export type ExportRenderReply =
  /** The drawn diagram (`mermaidSvgPage`). */
  | { type: 'svg'; svg: string }
  /** The PNG's bytes, base64, and its size in pixels (`pngCapturePage`). */
  | { type: 'png'; base64: string; width: number; height: number }
  /** The html artifact's pages, each a PNG's bytes, base64 (`htmlRasterPage`). */
  | { type: 'pages'; pages: string[] }
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
 * The mermaid and PNG pages' way back to the app: `post(reply)`, `messageOf(error)`.
 * Everything `post` uses is taken when the helpers run, and the message is written by
 * hand, the token never set on or serialized with an object: a script that runs later
 * and replaces the bridge, `String`, `JSON`, or adds setters or `toJSON` to
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
 * inside the render's own timeout ({@link HTML_RENDER_TIMEOUT_MS}), which ends a page
 * whose script never yields.
 */
export const HTML_SETTLE = {
  tickMs: 100,
  quietMs: 500,
  minAfterLoadMs: 1000,
  maxAfterLoadMs: 5000,
  maxLoadMs: 15_000
} as const

/**
 * An html artifact's render: its settle (20 s at most), then drawing every page
 * (about a second for a few pages; a long report takes longer).
 */
export const HTML_RENDER_TIMEOUT_MS = 90_000

/**
 * The page an html artifact is laid out and cut at, in CSS pixels: A4 (595 × 842 pt)
 * less expo-print's 1cm (28 pt) margins is 539 × 786 pt. The print scales each picture
 * to the sheet's width (`htmlPrintDocument`); at 780/539 of that width at most, it is
 * shorter than the sheet, so rounding never pushes one onto a second sheet.
 */
export const HTML_PAGE = { width: 539, height: 780 } as const

/** Drawn at 2x (≈ 144 dpi on paper). */
const RASTER_SCALE = 2
/**
 * Pages drawn per html2canvas call: each call clones the whole document, so fewer calls
 * are faster; four pages at 2x are a 1078 × 6240 canvas (≈ 6.7M pixels, under iOS's
 * 16.7M-pixel canvas limit).
 */
const PAGES_PER_DRAW = 4
/** A page ends at a blank band in its last fifth when there is one: no line cut in half. */
const SOFT_BREAK = 0.2

/** The artifact frame's id in the host page, and what it posts to the host. */
const ARTIFACT_FRAME_ID = 'slz-export-artifact'
const SNAPSHOT_MESSAGE = 'slz-export-snapshot'
const SNAPSHOT_FAILED_MESSAGE = 'slz-export-failed'

/**
 * The snapshot script, first in the artifact's document (`htmlArtifactDocument`): once
 * the page has loaded and its DOM has gone quiet, it posts the host a copy of the DOM as
 * drawn — each readable `<canvas>` as the picture it holds, style rules added by script
 * (CSSOM) as text, form fields as filled in, no scripts. It runs beside the artifact's
 * own scripts in the artifact's frame, so nothing it posts is trusted: the host parses
 * it, keeps only what can't run or load a page, and draws it (`hostScript`).
 */
const snapshotScript = (): string => `(function () {
  var doc = document;
  if (doc.currentScript) doc.currentScript.remove();
  var apply = Reflect.apply;
  var host = window.parent;
  var send = host.postMessage;
  var now = Date.now;
  var wait = setTimeout;
  var S = ${scriptJson(HTML_SETTLE)};
  function post(message) { apply(send, host, [message, '*']); }

  // Script-drawn content the DOM doesn't hold: canvas pixels, CSSOM rules, field values.
  function keepDrawn(live, copy) {
    var canvases = live.querySelectorAll('canvas'), copies = copy.querySelectorAll('canvas');
    var kept = ['id', 'class', 'width', 'height'];
    for (var i = 0; i < canvases.length && i < copies.length; i++) {
      var url;
      try { url = canvases[i].toDataURL('image/png'); } catch (e) { continue; }
      if (typeof url !== 'string' || url.indexOf('data:image/') !== 0) continue;
      var img = doc.createElement('img');
      for (var a = 0; a < kept.length; a++) {
        var value = copies[i].getAttribute(kept[a]);
        if (value !== null) img.setAttribute(kept[a], value);
      }
      // Its size as laid out, shrunk to fit the printed page's width.
      var style = copies[i].getAttribute('style');
      img.setAttribute('style', (style ? style.replace(/;?\\s*$/, ';') : '') + 'max-width:100%;height:auto');
      img.setAttribute('src', url);
      copies[i].replaceWith(img);
    }
    var styles = live.querySelectorAll('style'), styleCopies = copy.querySelectorAll('style');
    for (var j = 0; j < styles.length && j < styleCopies.length; j++) {
      try {
        var rules = styles[j].sheet && styles[j].sheet.cssRules;
        if (!rules) continue;
        var css = '';
        for (var k = 0; k < rules.length; k++) css += rules[k].cssText + '\\n';
        // A "<" is only ever inside a CSS string here; escaped, no "</style>" can form.
        styleCopies[j].textContent = css.replace(/</g, '\\\\3c ');
      } catch (e) {}
    }
    var fields = live.querySelectorAll('input'), fieldCopies = copy.querySelectorAll('input');
    for (var f = 0; f < fields.length && f < fieldCopies.length; f++) {
      var field = fields[f], fieldCopy = fieldCopies[f];
      if (field.type === 'checkbox' || field.type === 'radio') {
        if (field.checked) fieldCopy.setAttribute('checked', '');
        else fieldCopy.removeAttribute('checked');
      } else if (field.type !== 'file' && field.type !== 'password') {
        fieldCopy.setAttribute('value', field.value);
      }
    }
    var adopted = doc.adoptedStyleSheets, head = copy.querySelectorAll('head')[0];
    if (adopted && head) {
      for (var s = 0; s < adopted.length; s++) {
        try {
          var sheetCss = '';
          for (var r = 0; r < adopted[s].cssRules.length; r++) sheetCss += adopted[s].cssRules[r].cssText + '\\n';
          var adoptedStyle = doc.createElement('style');
          adoptedStyle.textContent = sheetCss.replace(/</g, '\\\\3c ');
          head.append(adoptedStyle);
        } catch (e) {}
      }
    }
  }

  function snapshot() {
    var live = doc.documentElement;
    var copy = live.cloneNode(true);
    try { keepDrawn(live, copy); } catch (e) {}
    var scripts = copy.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) scripts[i].remove();
    return copy.outerHTML;
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
      post({ type: ${scriptJson(SNAPSHOT_FAILED_MESSAGE)}, message: '' + (error && error.message ? error.message : error) });
      return;
    }
    post({ type: ${scriptJson(SNAPSHOT_MESSAGE)}, html: html });
  })();
})();`

/**
 * The policy of the frame the host draws the snapshot in: no script at all (inline,
 * remote, event handler or `javascript:` URL), no frame, plugin or request but the
 * styles, pictures and fonts the artifact showed.
 */
export const HTML_STAGE_POLICY =
  "default-src 'none'; script-src 'none'; img-src data: http: https:; style-src 'unsafe-inline' http: https:; font-src data: http: https:"

/**
 * The host page's script (see `htmlRasterPage`). The host's own realm runs only this and
 * html2canvas: no artifact code ever runs here, so the token is safe in it.
 */
const hostScript = (token: string): string => `(function () {
  var head = ${scriptJson(`{"source":${JSON.stringify(EXPORT_RENDER_SOURCE)},"token":${JSON.stringify(token)}`)};
  var handlers = window.webkit && window.webkit.messageHandlers;
  var bridge = (handlers && handlers.ReactNativeWebView) || window.ReactNativeWebView;
  var W = ${HTML_PAGE.width}, PAGE = ${HTML_PAGE.height}, SCALE = ${RASTER_SCALE};
  var PER_DRAW = ${PAGES_PER_DRAW}, SOFT = ${SOFT_BREAK};
  var POLICY = ${scriptJson(HTML_STAGE_POLICY)};
  // Whatever can run, navigate, load a page or a plugin, or hide content: never staged.
  var DROPPED = ${scriptJson(DROPPED_ELEMENTS.join(' '))}.split(' ');
  var SCRIPT_URL = /^[\\u0000-\\u0020]*(javascript|vbscript):/i;

  function post(reply) { bridge.postMessage(head + ',' + JSON.stringify(reply).slice(1)); }
  function messageOf(error) { return error && error.message ? '' + error.message : '' + error; }
  function fail(error) {
    var tainted = error && error.name === 'SecurityError';
    post({ type: 'error', code: tainted ? 'tainted' : 'render', message: messageOf(error) });
  }
  function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  // The snapshot, parsed (no browsing context: nothing loads or runs) and made inert.
  // Whatever the artifact's serialization did, this is the tree that gets staged: the
  // parse is never repeated, so nothing can re-parse into something else.
  function inert(html) {
    var parsed = new DOMParser().parseFromString(html, 'text/html');
    var all = parsed.getElementsByTagName('*'), list = [];
    for (var i = 0; i < all.length; i++) list.push(all[i]);
    for (var j = 0; j < list.length; j++) {
      var el = list[j], name = String(el.localName).toLowerCase();
      var sheet = name === 'link' && /(^|\\s)stylesheet(\\s|$)/i.test(el.getAttribute('rel') || '');
      if (DROPPED.indexOf(name) !== -1 || (name === 'link' && !sheet)) { el.remove(); continue; }
      for (var a = el.attributes.length - 1; a >= 0; a--) {
        var attr = el.attributes[a], key = attr.name.toLowerCase();
        var url = attr.value.replace(/[\\t\\n\\r]/g, '');
        if (key.indexOf('on') === 0 || key === 'srcdoc' || SCRIPT_URL.test(url)) el.removeAttribute(attr.name);
      }
    }
    return parsed;
  }

  // The stage: a frame of this page's origin (so html2canvas can read it) whose policy,
  // first in its head before any of the artifact's content, lets nothing run.
  function stage(html) {
    var parsed = inert(html);
    var frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin allow-scripts');
    frame.setAttribute('title', 'Export');
    document.body.appendChild(frame);
    var doc = frame.contentDocument;
    var policy = doc.createElement('meta');
    policy.setAttribute('http-equiv', 'Content-Security-Policy');
    policy.setAttribute('content', POLICY);
    doc.head.insertBefore(policy, doc.head.firstChild);
    var root = parsed.documentElement;
    for (var i = 0; i < root.attributes.length; i++) {
      doc.documentElement.setAttribute(root.attributes[i].name, root.attributes[i].value);
    }
    var parts = parsed.head ? doc.importNode(parsed.head, true) : null;
    while (parts && parts.firstChild) doc.head.appendChild(parts.firstChild);
    var body = parsed.body ? doc.importNode(parsed.body, true) : doc.createElement('body');
    doc.documentElement.replaceChild(body, doc.body);
    // Fail closed: nothing dropped above may be in the stage.
    var found = doc.querySelectorAll(DROPPED.join(','));
    for (var k = 0; k < found.length; k++) {
      if (found[k] !== policy) throw new Error('The page holds content the export cannot draw safely.');
    }
    return doc;
  }

  // Images and stylesheets loaded (or failed), fonts ready: then the layout is final.
  function loaded(doc) {
    var until = Date.now() + 5000;
    function done() {
      var images = doc.images;
      for (var i = 0; i < images.length; i++) if (!images[i].complete) return false;
      var links = doc.querySelectorAll('link');
      for (var j = 0; j < links.length; j++) if (!links[j].sheet) return false;
      return true;
    }
    function poll() { return done() || Date.now() > until ? null : delay(100).then(poll); }
    var fonts = doc.fonts && doc.fonts.ready ? doc.fonts.ready : null;
    return Promise.resolve(poll())
      .then(function () { return fonts && Promise.race([fonts, delay(3000)]); })
      .then(function () { return delay(50); });
  }

  // Rows [y, y + band) of the drawing all one colour.
  function blank(context, width, y, band) {
    var data = context.getImageData(0, y, width, band).data;
    for (var i = 4; i < data.length; i += 4) {
      if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2] || data[i + 3] !== data[3]) return false;
    }
    return true;
  }

  // Where the page starting at pixel row y ends: at a blank band in its last fifth, else full.
  function pageEnd(context, width, y, full) {
    for (var end = full; end >= full * (1 - SOFT); end -= SCALE) {
      if (blank(context, width, y + end - SCALE, SCALE)) return end;
    }
    return full;
  }

  // Exported pages are paper, not app chrome: white whatever the theme.
  var PAPER = 'white';

  function picture(canvas, y, height) {
    var page = document.createElement('canvas');
    page.width = canvas.width;
    page.height = height;
    var context = page.getContext('2d');
    context.fillStyle = PAPER;
    context.fillRect(0, 0, page.width, height);
    context.drawImage(canvas, 0, y, canvas.width, height, 0, 0, canvas.width, height);
    var url = page.toDataURL('image/png');
    var prefix = 'data:image/png;base64,';
    if (url.indexOf(prefix) !== 0 || url.length === prefix.length) throw new Error('A page is too large to draw.');
    return url.slice(prefix.length);
  }

  // Cuts a drawing of the page from \`top\` into pages; returns the CSS pixels used (the
  // rest, less than a page, starts the next drawing unless this is the last).
  function cut(canvas, last, pages) {
    var context = canvas.getContext('2d');
    var full = PAGE * SCALE, y = 0;
    while (canvas.height - y > 0) {
      var left = canvas.height - y, end;
      if (left <= full) {
        if (!last) break;
        end = left;
      } else {
        end = pageEnd(context, canvas.width, y, full);
      }
      pages.push(picture(canvas, y, end));
      y += end;
    }
    return y / SCALE;
  }

  function draw(doc) {
    var root = doc.documentElement;
    var total = Math.max(1, Math.ceil(Math.max(root.scrollHeight, doc.body ? doc.body.scrollHeight : 0)));
    var pages = [], top = 0;
    function next() {
      if (top >= total) return Promise.resolve(pages);
      var height = Math.min(PAGE * PER_DRAW, total - top);
      var last = top + height >= total;
      return html2canvas(root, {
        x: 0, y: top, width: W, height: height, windowWidth: W, windowHeight: PAGE,
        scrollX: 0, scrollY: 0, scale: SCALE, backgroundColor: PAPER,
        useCORS: true, logging: false, imageTimeout: 10000
      }).then(function (canvas) {
        top += cut(canvas, last, pages);
        return next();
      });
    }
    return next();
  }

  var taken = false;
  window.addEventListener('message', function (event) {
    var frame = document.getElementById(${scriptJson(ARTIFACT_FRAME_ID)});
    // Only the artifact's own frame (not a frame inside it), and only its first answer.
    if (taken || !frame || event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    var failed = data.type === ${scriptJson(SNAPSHOT_FAILED_MESSAGE)};
    if (!failed && (data.type !== ${scriptJson(SNAPSHOT_MESSAGE)} || typeof data.html !== 'string')) return;
    taken = true;
    // The artifact stops running here: its frame is gone before anything is drawn.
    frame.remove();
    if (failed) {
      fail(new Error('' + data.message));
      return;
    }
    var doc;
    try { doc = stage(data.html); } catch (error) { fail(error); return; }
    loaded(doc)
      .then(function () { return draw(doc); })
      .then(function (pages) { post({ type: 'pages', pages: pages }); }, fail);
  });
})();`

/** Elements never staged (see `hostScript`): they run, navigate, load, or hide. */
const DROPPED_ELEMENTS = [
  'script',
  'noscript',
  'template',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'portal',
  'fencedframe',
  'meta'
] as const

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

/** A script for inline embedding: refused if it could end its element early. */
function inlineHostScript(js: string): string {
  if (/<\/?script|<!--/i.test(js)) throw new Error('htmlRasterPage: a script holds a script tag')
  return `<script>${js}</script>`
}

/**
 * The artifact's document as its frame runs it: the shared html document
 * (`buildDocumentHtml`, no policy: the artifact runs as it does in the viewer and on
 * desktop) with the snapshot script first in its head.
 */
export function htmlArtifactDocument(content: string, title: string): string {
  const html = buildDocumentHtml(content, 'html-preview', title)
  const at = html.indexOf('<head>')
  if (at === -1) throw new Error('htmlArtifactDocument: the document has no head')
  const head = at + '<head>'.length
  return `${html.slice(0, head)}${inlineHostScript(snapshotScript())}${html.slice(head)}`
}

/**
 * An html artifact's render page: a host page (the web view's top document) with the
 * artifact in an `<iframe sandbox="allow-scripts">` — the viewer's own sandbox: the
 * artifact's scripts run on an opaque origin, with no dialogs (no `allow-modals`; a frame
 * the artifact makes inherits that), popups, top navigation or forms, and it can't reach
 * the host or its token. The host takes the frame's snapshot (from that frame only),
 * removes the frame, stages the snapshot inert in a frame of its own, draws it page by
 * page with html2canvas, and posts the pages to the app as PNGs, carrying its token.
 * Laid out at the printed page's width.
 */
export function htmlRasterPage(
  content: string,
  title: string,
  html2canvasScript: string
): ExportRenderPage {
  const token = newToken()
  const frame = escapeAttribute(htmlArtifactDocument(content, title))
  const html = [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta name="viewport" content="width=${HTML_PAGE.width}, initial-scale=1">`,
    `<style>html, body { margin: 0; background: #fff; } iframe { display: block; border: 0; width: ${HTML_PAGE.width}px; height: ${HTML_PAGE.height}px; }</style>`,
    '</head><body>',
    inlineHostScript(html2canvasScript),
    inlineHostScript(hostScript(token)),
    `<iframe id="${ARTIFACT_FRAME_ID}" sandbox="allow-scripts" title="Export" srcdoc="${frame}"></iframe>`,
    '</body></html>'
  ].join('')
  return { html, token, viewport: HTML_PAGE, timeoutMs: HTML_RENDER_TIMEOUT_MS }
}

/** A page picture: PNG bytes as base64, nothing else. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** The printer's policy: it loads the page pictures (inline) and nothing else. */
export const HTML_PRINT_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'"

/**
 * The document expo-print prints for an html artifact: its page pictures, one per
 * sheet, and nothing of the artifact's — no markup, no text, no URL. Each picture is
 * checked to be base64 before it is written into the document.
 */
export function htmlPrintDocument(pages: readonly string[]): string {
  if (pages.length === 0) throw new Error('htmlPrintDocument: no pages')
  for (const page of pages) {
    if (!BASE64.test(page)) throw new Error('htmlPrintDocument: a page is not a PNG')
  }
  const pictures = pages.map((page) => `<img alt="" src="data:image/png;base64,${page}">`)
  return [
    '<!DOCTYPE html><html><head>',
    `<meta http-equiv="Content-Security-Policy" content="${HTML_PRINT_POLICY}">`,
    '<style>html, body { margin: 0; padding: 0; background: #fff; }',
    ' img { display: block; width: 100%; height: auto; break-inside: avoid; }',
    ' img + img { break-before: page; }</style>',
    `</head><body>${pictures.join('')}</body></html>`
  ].join('')
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
    case 'pages':
      return Array.isArray(r.pages) &&
        r.pages.length > 0 &&
        r.pages.every((page) => typeof page === 'string' && BASE64.test(page))
        ? { type: 'pages', pages: r.pages as string[] }
        : null
    case 'error':
      return (r.code === 'render' || r.code === 'tainted') && typeof r.message === 'string'
        ? { type: 'error', code: r.code, message: r.message }
        : null
    default:
      return null
  }
}
