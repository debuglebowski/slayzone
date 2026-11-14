/**
 * The web shell's export frame: the page an artifact is printed in (PDF export).
 *
 * An artifact is a document of its own — an html report with its scripts and remote
 * styles, markdown with remote images, a mermaid diagram drawn by its inlined build —
 * and must render as written. It must never run with the hub's origin, where the
 * signed-in person's session lives. The shell's own policy cannot host it either: a
 * `srcdoc` frame inherits `script-src 'self'` and the shell's `img-src`, and `data:` /
 * `blob:` frames are refused by its `default-src 'self'`.
 *
 * So the hub serves this page, with a policy of its own (`EXPORT_FRAME_CSP`,
 * security-headers.ts): `sandbox allow-scripts allow-modals` gives it an opaque origin
 * wherever it is opened — framed by the shell or opened directly — so nothing in it can
 * reach the hub's cookies, storage or pages; its content directives let a document
 * render as written; `frame-ancestors 'self'` lets only the hub's own pages frame it.
 *
 * The page is a bootstrap and nothing else (web-shell `artifact-export.ts` drives it):
 *   1. It tells its parent it is here: `{ slayzoneExportFrame: EXPORT_FRAME_VERSION }`.
 *   2. It takes ONE message from its parent, `{ slayzoneExport: id, html, waitForReady }`,
 *      and writes `html` as its document (`document.open/write/close`).
 *   3. Once the document has loaded (images, styles, scripts), its fonts are ready and,
 *      with `waitForReady`, it has flagged itself ready (`data-export-ready="1"`, the
 *      mermaid document's flag) — or after `deadlineMs` — it reports
 *      `{ slayzoneExport: id, state: 'ready', images: { total, loaded }, drawn }`, then
 *      prints, and reports `{ slayzoneExport: id, state: 'done' }` on `afterprint`.
 *      A failure reports `{ slayzoneExport: id, state: 'error', message }`.
 * A document carrying its own policy (the markdown/code/mermaid documents' nonce'd CSP
 * meta) keeps it: it constrains the document's scripts, not this bootstrap, which is
 * already running when the document is written.
 *
 * @module server/export-frame
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Where the hub serves the page. */
export const EXPORT_FRAME_PATH = '/export-frame'

/**
 * The protocol's version, announced in the page's first message. A shell that speaks
 * another (a tab left open across a hub upgrade) refuses to print and asks for a reload.
 */
export const EXPORT_FRAME_VERSION = 1

const BOOTSTRAP = `(function () {
  'use strict';
  var host = window.parent;
  if (host === window) return;
  var taken = false;
  function post(message) { host.postMessage(message, '*'); }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (taken || event.source !== host || !data) return;
    if (typeof data.slayzoneExport !== 'string' || typeof data.html !== 'string') return;
    taken = true;
    render(data.slayzoneExport, data.html, data.waitForReady === true,
      typeof data.deadlineMs === 'number' ? data.deadlineMs : 30000);
  });

  function render(id, html, waitForReady, deadlineMs) {
    function fail(err) {
      post({ slayzoneExport: id, state: 'error', message: String((err && err.message) || err) });
    }
    try {
      document.open();
      document.write(html);
      document.close();
    } catch (err) {
      fail(err);
      return;
    }
    // document.open() removed every listener this page had: nothing else is listening.
    var deadline = Date.now() + deadlineMs;
    var fontsReady = !document.fonts;
    if (document.fonts) {
      document.fonts.ready.then(function () { fontsReady = true; }, function () { fontsReady = true; });
    }
    function drawn() {
      var root = document.documentElement;
      return !waitForReady || (!!root && root.getAttribute('data-export-ready') === '1');
    }
    function check() {
      var settled = document.readyState === 'complete' && fontsReady && drawn();
      if (settled || Date.now() >= deadline) print_(settled);
      else setTimeout(check, 50);
    }
    function print_(settled) {
      var images = document.images;
      var loaded = 0;
      for (var i = 0; i < images.length; i++) {
        if (images[i].complete && images[i].naturalWidth > 0) loaded++;
      }
      post({
        slayzoneExport: id,
        state: 'ready',
        settled: settled,
        drawn: drawn(),
        images: { total: images.length, loaded: loaded }
      });
      window.addEventListener('afterprint', function () {
        post({ slayzoneExport: id, state: 'done' });
      }, { once: true });
      // The next task: the ready report goes out before the dialog takes the thread.
      setTimeout(function () {
        try {
          window.focus();
          window.print();
        } catch (err) {
          fail(err);
        }
      }, 0);
    }
    check();
  }

  post({ slayzoneExportFrame: ${EXPORT_FRAME_VERSION} });
})();`

/** The page itself: the bootstrap, nothing to render until the shell sends a document. */
export const EXPORT_FRAME_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Export</title></head><body><script>${BOOTSTRAP}</script></body></html>`

function pathnameOf(url: string | undefined): string {
  const raw = (url ?? '/').split('?')[0]
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** True when a raw request URL names the export frame (security-headers.ts picks its policy by it). */
export function isExportFrameUrl(url: string | undefined): boolean {
  return pathnameOf(url) === EXPORT_FRAME_PATH
}

/**
 * Serve the export frame for GET/HEAD `/export-frame`; false for anything else, `res`
 * untouched. Revalidated on every request: it must match the shell that frames it.
 */
export function handleExportFrame(req: IncomingMessage, res: ServerResponse): boolean {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') return false
  if (!isExportFrameUrl(req.url)) return false
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache'
  })
  res.end(method === 'HEAD' ? undefined : EXPORT_FRAME_HTML)
  return true
}
