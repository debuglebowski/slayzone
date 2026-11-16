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
 *   2. It takes ONE message from its parent, `{ slayzoneExport: id, html, waitForReady }`
 *      with a MessagePort, and writes `html` as its document (`document.open/write/
 *      close`). The page's alert/confirm/prompt are no-ops by then (`allow-modals` is
 *      only for print(); see `silenceDialogs`, and its known gap). On the port it
 *      answers the shell's `{ ping: n }` with `{ pong: n }`: the shell counts every
 *      load of the frame as a navigation unless the bootstrap vouches for it.
 *   3. Once the document has loaded (images, styles, scripts), its fonts are ready and,
 *      with `waitForReady`, it has flagged itself ready (`data-export-ready="1"`, the
 *      mermaid document's flag) — or after `deadlineMs` — it reports
 *      `{ slayzoneExport: id, state: 'ready', images: { total, loaded }, drawn }` and
 *      prints, in one task, and reports `{ slayzoneExport: id, state: 'done' }` on
 *      `afterprint`. A failure reports `{ slayzoneExport: id, state: 'error', message }`.
 *   A navigation away from the document (meta refresh, `location.href`, a link) ends
 *   the export: reported as `{ slayzoneExport: id, state: 'navigated' }` when the
 *   bootstrap sees it start, and nothing is printed. The next document is not this
 *   bootstrap's and has no dialog lock; the shell has taken `allow-modals` from the
 *   frame's sandbox by then (a change that applies at its next navigation), so it can
 *   raise no dialog and print nothing, and it cannot vouch for its load.
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
export const EXPORT_FRAME_VERSION = 2

const BOOTSTRAP = `(function () {
  'use strict';
  var host = window.parent;
  if (host === window) return;
  silenceDialogs(window);
  var taken = false;
  function post(message) { host.postMessage(message, '*'); }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (taken || event.source !== host || !data) return;
    if (typeof data.slayzoneExport !== 'string' || typeof data.html !== 'string') return;
    taken = true;
    vouch(event.ports && event.ports[0]);
    render(data.slayzoneExport, data.html, data.waitForReady === true,
      typeof data.deadlineMs === 'number' ? data.deadlineMs : 30000);
  });

  // The shell treats every load of this frame as a navigation (a document without
  // this bootstrap) unless the bootstrap vouches for it: it answers the shell's pings
  // on the channel the shell sent with the document. Only this realm holds that port,
  // and a port outlives document.open() (it is no listener of the window or document).
  function vouch(port) {
    if (!port) return;
    port.onmessage = function (event) {
      var data = event.data;
      if (data && typeof data.ping === 'number') port.postMessage({ pong: data.ping });
    };
  }

  function render(id, html, waitForReady, deadlineMs) {
    var left = false;
    function fail(err) {
      post({ slayzoneExport: id, state: 'error', message: String((err && err.message) || err) });
    }
    // A navigation away from this document (meta refresh, location.href, a link) is
    // the end of the export: the next document is not the artifact as written, and
    // has no dialog lock (the shell gives it no allow-modals). Reported as it starts,
    // and this document never prints.
    function leaving() {
      if (left) return;
      left = true;
      post({ slayzoneExport: id, state: 'navigated' });
    }
    function watchLeaving() {
      // Capture listeners run first at the window. Re-adding is a no-op while they
      // are still there.
      window.addEventListener('beforeunload', leaving, true);
      window.addEventListener('pagehide', leaving, true);
    }
    try {
      document.open();
      // document.open() removed every listener this page had. Watch before the
      // document is written: its inline scripts may navigate while it is parsed.
      // A later document.open() of the artifact's removes these again; the observer
      // that sees it replace the document puts them back (silenceChildren). A
      // navigation started in between is caught by the shell: this document no
      // longer vouches for the frame's loads.
      watchLeaving();
      document.write(html);
      document.close();
    } catch (err) {
      fail(err);
      return;
    }
    silenceChildren(watchLeaving);
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
      if (left) return;
      var settled = document.readyState === 'complete' && fontsReady && drawn();
      if (settled || Date.now() >= deadline) print_(settled);
      else setTimeout(check, 50);
    }
    function print_(settled) {
      // The next task: whatever the document does in between (navigate away) is seen
      // first. Then ready and print() in ONE task: nothing of the document's runs
      // between the report and the dialog, so the shell knows from ready on that the
      // document printing is this one.
      setTimeout(function () {
        if (left) return;
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

  // The frame keeps allow-modals for print(), so the document it writes could raise a
  // native dialog over the shell (a fake "password?" prompt). Its own alert/confirm/
  // prompt become no-ops before it is written, and stay ours: not deletable, writable
  // or redefinable (window's own properties outlive document.open()).
  function silenceDialogs(w) {
    var quiet = { alert: function () {}, confirm: function () { return false; }, prompt: function () { return null; } };
    for (var name in quiet) {
      try {
        Object.defineProperty(w, name, { value: quiet[name], writable: false, enumerable: true, configurable: false });
      } catch (err) {
        // Already ours, or a child this realm cannot reach.
      }
    }
  }
  // A child frame the document adds, when this realm can reach it. Chromium gives a
  // sandboxed document's about:blank child a fresh opaque origin, so it is unreachable
  // there, and so are its dialogs to the document; this covers an engine that shares it.
  // KNOWN GAP: a cross-origin child the document creates (srcdoc, javascript:, data:,
  // a remote page) inherits allow-modals (sandbox flags inherit) and can still raise a
  // dialog in Chromium. Every way to stop it, measured in Chromium, costs print
  // fidelity: print() is ignored without allow-modals; printing the document from a
  // modal-less inner frame slices it by height and drops its page breaks; frame-src
  // 'none' drops remote iframes and still lets srcdoc through; printing a script-free
  // copy loses canvas, shadow DOM and live state. (WebKit computes a child's flags
  // from the frame's current sandbox attribute, which the shell has stripped of
  // allow-modals by then: no dialog there.) Not this gap: the document navigating THIS
  // frame to a new document (render's leaving() and the shell's load guard).
  function silenceChildren(onMutation) {
    function each() {
      onMutation();
      for (var i = 0; i < window.length; i++) {
        try { silenceDialogs(window[i]); } catch (err) { /* cross-origin */ }
      }
    }
    each();
    if (typeof MutationObserver === 'function') {
      new MutationObserver(each).observe(document, { childList: true, subtree: true });
    }
    document.addEventListener('load', each, true);
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
