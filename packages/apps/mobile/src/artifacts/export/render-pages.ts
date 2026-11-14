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
 * Each page runs only its own scripts (a nonce'd policy, as the viewer's pages): a
 * script inside an artifact's SVG never runs.
 */
import { mermaidInitOptions } from '@slayzone/markdown/mermaid-config'
import { buildPngHtml } from '@slayzone/task-artifacts/export-html'
import { contentPolicy, inlineScript, newNonce, pageShell } from '../pages/page-style'

/** Marks the replies of these pages among anything else a page could post. */
export const EXPORT_RENDER_SOURCE = 'slayzone-export'

export type ExportRenderErrorCode = 'render' | 'tainted'

export type ExportRenderReply =
  /** The drawn diagram (`mermaidSvgPage`). */
  | { type: 'svg'; svg: string }
  /** The PNG's bytes, base64, and its size in pixels (`pngCapturePage`). */
  | { type: 'png'; base64: string; width: number; height: number }
  /** `render`: nothing could be drawn (`message` says why); `tainted`: see above. */
  | { type: 'error'; code: ExportRenderErrorCode; message: string }

/** A value as script source, safe inside an inline `<script>`. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** The pages' way back to the app: `post(reply)`, `messageOf(error)`. */
const REPLY_HELPERS = `
  function post(reply) {
    reply.source = ${scriptJson(EXPORT_RENDER_SOURCE)};
    window.ReactNativeWebView.postMessage(JSON.stringify(reply));
  }
  function messageOf(error) {
    return error && error.message ? String(error.message) : String(error);
  }`

export function mermaidSvgPage(
  source: string,
  mermaidScript: string,
  options: { htmlLabels: boolean }
): string {
  const nonce = newNonce()
  const init = { ...mermaidInitOptions('light'), htmlLabels: options.htmlLabels }
  const draw = `(function () {${REPLY_HELPERS}
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
  return pageShell({
    policy: contentPolicy(nonce),
    css: 'body { margin: 0; }',
    body: '<div id="export-host"></div>',
    scripts: inlineScript(nonce, mermaidScript) + inlineScript(nonce, draw)
  })
}

/**
 * iOS refuses a canvas over 16.7M pixels (4096²) and hands back an empty image; the
 * scale drops below 2x to stay under it.
 */
const MAX_CANVAS_PIXELS = 16_000_000

const CAPTURE_SCRIPT = `(function () {${REPLY_HELPERS}
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

export function pngCapturePage(svg: string, title: string): string {
  // The shared document's own policy allows only scripts carrying this nonce: the
  // capture script below carries it.
  const nonce = newNonce()
  const html = buildPngHtml(svg, 'svg-preview', title, null, { nonce })
  if (html === null) throw new Error('pngCapturePage: no PNG document for an SVG')
  const policy = contentPolicy(nonce).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`
  // The document's own head and its last `</body>`: the SVG inside can hold anything.
  const withPolicy = html.replace('<head>', () => `<head>${meta}`)
  const end = withPolicy.lastIndexOf('</body>')
  return `${withPolicy.slice(0, end)}${inlineScript(nonce, CAPTURE_SCRIPT)}${withPolicy.slice(end)}`
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A reply of these pages, or null for anything else. */
export function parseExportRenderReply(data: string): ExportRenderReply | null {
  let raw: unknown
  try {
    raw = JSON.parse(data)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.source !== EXPORT_RENDER_SOURCE) return null
  switch (r.type) {
    case 'svg':
      return typeof r.svg === 'string' ? { type: 'svg', svg: r.svg } : null
    case 'png':
      return typeof r.base64 === 'string' && isNumber(r.width) && isNumber(r.height)
        ? { type: 'png', base64: r.base64, width: r.width, height: r.height }
        : null
    case 'error':
      return (r.code === 'render' || r.code === 'tainted') && typeof r.message === 'string'
        ? { type: 'error', code: r.code, message: r.message }
        : null
    default:
      return null
  }
}
