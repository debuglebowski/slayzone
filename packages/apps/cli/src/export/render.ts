/**
 * Rasterises an export document (from `@slayzone/task-artifacts/export-html`) in a
 * local headless browser over CDP. Mirrors the desktop app's offscreen-window
 * renderer (`renderToPdf` / `renderToPng` in task/src/electron/artifact-export.ts) so
 * both produce the same output: PDF = A4, backgrounds printed, 1 cm margins; PNG =
 * a 2000×2000 viewport, the drawing measured and the viewport shrunk to it, captured
 * at device scale factor 2.
 *
 * The document goes in with `Page.setDocumentContent`, not a temp file: nothing is
 * shared through the filesystem, which a sandboxed (snap) browser could not read.
 *
 * JS dialogs (alert / confirm / prompt / beforeunload) are dismissed as they open: an
 * html artifact runs its scripts, and an unanswered dialog blocks the page — its
 * document never finishes loading, nor does a print or capture. Dismissed means
 * `accept: false`: confirm() returns false, prompt() null, beforeunload stays.
 *
 * What else an artifact's scripts could do is held to what desktop's export window
 * allows (task/src/electron/artifact-export.ts, which serves the document sandboxed):
 *  - no downloads: refused browser-wide, so nothing lands in the person's Downloads;
 *  - no leaving the document: a navigation of the page itself (meta refresh,
 *    `location.href =`, to http, data:, blob: or anything else) is refused before
 *    anything is requested, and the export FAILS — what it would print is no longer
 *    the artifact. Navigations within the document (fragment, history API) and a child
 *    frame's own are the artifact's business and go on;
 *  - `print()` does nothing: the export's print is the browser's printToPDF, and a
 *    page print() in the way fails it ("Page is already being printed").
 * Why not desktop's way (the document served with `CSP: sandbox allow-scripts`): a
 * document served with a header must come from a URL, and Chrome's Local Network
 * Access then refuses the opaque-origin page every image on localhost or the LAN — an
 * artifact's `![](http://localhost:3000/shot.png)` would export blank. The document
 * put into `about:blank` loads them, as before.
 */
import {
  EXPORT_READY_EXPRESSION,
  PNG_MEASURE_EXPRESSION
} from '@slayzone/task-artifacts/export-html'
import { type Browser, type LaunchOptions, launchBrowser, openPage } from './cdp'

export interface RenderOptions {
  /** The document flags itself ready asynchronously (mermaid): wait for it. */
  waitReady: boolean
  /** Ready-wait budget; past it the page is captured as it stands (desktop parity). */
  readyTimeoutMs?: number
  /** Called when the ready flag never came. */
  warn?: (line: string) => void
  /** Browser timing; tests shorten it. */
  browser?: LaunchOptions
}

const MM_PER_INCH = 25.4
const A4 = { width: 210 / MM_PER_INCH, height: 297 / MM_PER_INCH }
const MARGIN_IN = 10 / MM_PER_INCH
/** One `IO.read` of a streamed PDF. */
const PDF_READ_BYTES = 4 * 1024 * 1024
export const PNG_SCALE = 2
const PNG_VIEWPORT = 2000

interface EvalResult<T> {
  result: { value?: T }
  exceptionDetails?: { text?: string }
}

async function evaluate<T>(
  b: Browser,
  sessionId: string,
  expression: string,
  awaitPromise = false
): Promise<T | undefined> {
  const r = await b.send<EvalResult<T>>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise },
    sessionId
  )
  return r.exceptionDetails ? undefined : r.result.value
}

/**
 * Until `expression` is true in the page and `also()` holds, for at most `timeoutMs`.
 * The page is asked every round even while `also()` is false: a page gone meanwhile
 * fails the wait instead of letting it run out.
 */
async function poll(
  b: Browser,
  sessionId: string,
  expression: string,
  timeoutMs: number,
  also: () => boolean = () => true
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await evaluate<boolean>(b, sessionId, expression)) === true && also()) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 50))
  }
}

/**
 * The child frames of page `sessionId` (any but `frameId`, its main frame) that are
 * loading now, from the page's frame events. A cross-site child frame loads in a
 * process of its own, and the document's `readyState` turns complete without waiting
 * for it: the export would print before the frame had loaded (on a busy machine,
 * before it was even requested). Desktop's export waits for the load event
 * (did-finish-load), which waits for every child frame; so does this, through these.
 */
function trackChildFrames(b: Browser, sessionId: string, frameId: string): () => boolean {
  const loading = new Set<string>()
  b.onEvent((method, params, sid) => {
    const id = params.frameId
    if (sid !== sessionId || typeof id !== 'string' || id === frameId) return
    if (method === 'Page.frameStartedLoading') loading.add(id)
    else if (method === 'Page.frameStoppedLoading' || method === 'Page.frameDetached') {
      loading.delete(id)
    }
  })
  return () => loading.size === 0
}

/** The export document tried to load another document in its place. */
export class DocumentNavigationError extends Error {
  constructor(url: string) {
    const shown = url.length > 120 ? `${url.slice(0, 120)}…` : url
    super(
      `The document tried to navigate away (to ${shown}). An export renders only the ` +
        'artifact itself, so the export was stopped.'
    )
    this.name = 'DocumentNavigationError'
  }
}

/**
 * Run in the page before its document goes in (`setDocumentContent` keeps the window)
 * and in every document made later (child frames):
 *  - `print()` is a no-op: the page's own print never competes with the export's.
 *  - A click on a link marked as a download (`<a download>`, `<area download>`) does
 *    nothing: downloads are denied (`Browser.setDownloadBehavior`), and Chrome reports
 *    such a click to an http(s) URL as an ordinary navigation of the page (a
 *    `currentTab` anchor click, with nothing saying it is a download), which the
 *    navigation guard would take for the document leaving and fail the export. A
 *    download does not leave the document; desktop cancels it and exports. The listener
 *    is the window's first (capture), so nothing of the page's runs before it; the
 *    document going in (`document.open()`) erases the window's listeners, so an observer
 *    of the document puts it back (observers outlive `document.open()`, and the parser
 *    runs them before each of the document's scripts). Missed anyway, the click is still
 *    a navigation the guard refuses: the export fails, nothing is fetched.
 */
const PAGE_SCRIPT = `(() => {
  try { Object.defineProperty(window, 'print', { value: function print() {}, writable: true, configurable: true, enumerable: true }) } catch {}
  const deny = (event) => {
    for (const node of event.composedPath()) {
      if ((node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement) && node.hasAttribute('download')) {
        event.preventDefault()
        return
      }
    }
  }
  const watch = () => addEventListener('click', deny, true)
  watch()
  try { new MutationObserver(watch).observe(document, { childList: true, subtree: true }) } catch {}
})()`

/** Navigation types that stay in the same document (`Page.frameStartedNavigating`). */
const SAME_DOCUMENT = new Set(['sameDocument', 'historySameDocument'])

/** `to` only moves to a fragment of the document at `current` (`#section`). */
function sameDocument(current: string, to: unknown): boolean {
  const target = String(to ?? '')
  const hash = target.indexOf('#')
  return hash !== -1 && target.slice(0, hash) === current.split('#')[0]
}

/**
 * Keep page `sessionId` on its document: any navigation of its main frame
 * (`frameId`) fails every command of the page with a {@link DocumentNavigationError}.
 * One that would fetch something is also refused before it is sent (`Fetch`, Document
 * requests only — subresources never pause); a child frame's are let through. Every
 * kind of navigation is caught by at least one of: the request (http/https), the
 * renderer scheduling it or asking to navigate (any URL, before the browser acts —
 * including one Chrome then refuses itself), the browser starting it, the new
 * document committing. Call before the document goes in; `committed()`
 * once it is in (from then on any main-frame commit is a new document). `refused()`:
 * a navigation was refused (the browser must then be ended, not shut down).
 */
async function guardDocument(
  b: Browser,
  sessionId: string,
  frameId: string
): Promise<{ committed: () => void; refused: () => boolean }> {
  let inPlace = false
  let refused = false
  /** The document's URL (`about:blank`, then whatever the history API makes it). */
  let url = 'about:blank'
  const refuse = (url: unknown): void => {
    if (refused) return
    refused = true
    b.failPage(sessionId, new DocumentNavigationError(String(url ?? '')))
  }
  b.onEvent((method, params, sid) => {
    if (sid !== sessionId) return
    switch (method) {
      case 'Fetch.requestPaused': {
        const requestId = params.requestId
        if (params.frameId !== frameId) {
          b.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => undefined)
          return
        }
        // Answered even once the page is failed (cdp.ts delivers it): a request left
        // paused would be let through when the browser closes.
        b.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId).catch(
          () => undefined
        )
        refuse((params.request as { url?: unknown } | undefined)?.url)
        return
      }
      case 'Page.navigatedWithinDocument':
        if (params.frameId === frameId) url = String(params.url)
        return
      case 'Page.frameScheduledNavigation':
        // The one sign of a navigation Chrome refuses in the renderer itself (a page
        // sending itself to a data: document): refused here too, so the attempt still
        // fails the export. Only one due now — a refresh due later (a dashboard's
        // `<meta http-equiv=refresh content=60>`) is caught if and when it starts.
        if (params.frameId === frameId && params.delay === 0 && !sameDocument(url, params.url)) {
          refuse(params.url)
        }
        return
      case 'Page.frameRequestedNavigation':
        // Other dispositions open no document here (a popup, blocked without a
        // gesture; a download, denied). A click on an `<a download>` never gets here:
        // the page cancels it (PAGE_SCRIPT).
        if (params.frameId === frameId && params.disposition === 'currentTab') refuse(params.url)
        return
      case 'Page.frameStartedNavigating':
        if (params.frameId === frameId && !SAME_DOCUMENT.has(String(params.navigationType))) {
          refuse(params.url)
        }
        return
      case 'Page.frameNavigated': {
        const frame = params.frame as { id?: unknown; url?: unknown } | undefined
        if (inPlace && frame?.id === frameId) refuse(frame.url)
        return
      }
    }
  })
  await b.send(
    'Fetch.enable',
    { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] },
    sessionId
  )
  return {
    committed: () => {
      inPlace = true
    },
    refused: () => refused
  }
}

async function withPage<T>(
  executable: string,
  html: string,
  opts: RenderOptions,
  viewport: { width: number; height: number; deviceScaleFactor: number } | null,
  fn: (b: Browser, sessionId: string) => Promise<T>
): Promise<T> {
  const b = await launchBrowser(executable, opts.browser)
  let failed = false
  let guard: Awaited<ReturnType<typeof guardDocument>> | undefined
  try {
    // Before any page exists: nothing an artifact does saves a file (`<a download>`, a
    // navigation to an attachment). The page lives in the default context this covers.
    await b.send('Browser.setDownloadBehavior', { behavior: 'deny' })
    // Crash/destroy events and the renderer's process watched: a page that dies
    // mid-print fails the print at once instead of leaving it waiting (see cdp.ts).
    const { sessionId } = await openPage(b)
    // Page events on, so a dialog announces itself (Page.javascriptDialogOpening) and
    // is answered at once, wherever it opens: while the document loads, during the
    // ready wait, or from a timer mid-print. The listener goes with the browser.
    b.onEvent((method, _params, sid) => {
      if (method !== 'Page.javascriptDialogOpening' || sid !== sessionId) return
      // Fails only when the page is gone, which the pending command reports itself.
      b.send('Page.handleJavaScriptDialog', { accept: false }, sessionId).catch(() => undefined)
    })
    await b.send('Page.enable', {}, sessionId)
    if (viewport) {
      await b.send('Emulation.setDeviceMetricsOverride', { ...viewport, mobile: false }, sessionId)
    }
    const { frameTree } = await b.send<{ frameTree: { frame: { id: string } } }>(
      'Page.getFrameTree',
      {},
      sessionId
    )
    const frameId = frameTree.frame.id
    guard = await guardDocument(b, sessionId, frameId)
    const childFramesLoaded = trackChildFrames(b, sessionId, frameId)
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SCRIPT }, sessionId)
    await evaluate(b, sessionId, PAGE_SCRIPT)
    await b.send('Page.setDocumentContent', { frameId, html }, sessionId)
    guard.committed()
    // Subresources (images in markdown) and child frames loaded, then web fonts settled.
    await poll(b, sessionId, "document.readyState === 'complete'", 30_000, childFramesLoaded)
    await evaluate(b, sessionId, 'document.fonts.ready.then(() => true)', true)
    if (opts.waitReady) {
      const ok = await poll(b, sessionId, EXPORT_READY_EXPRESSION, opts.readyTimeoutMs ?? 10_000)
      if (!ok) opts.warn?.('Warning: the diagram did not finish drawing in time; exporting as is.')
    }
    return await fn(b, sessionId)
  } catch (err) {
    failed = true
    throw err
  } finally {
    // A close that fails (in practice: Windows still holding the temp profile, so it
    // could not be removed) must not replace the render's own error, nor discard a
    // good render — the output is complete; only the leftover is reported.
    // A refused navigation may still be under way (refused when the renderer asked, not
    // yet at the request): the browser is ended at once, before it could let the
    // request out — an orderly shutdown drops the interception first.
    await b.close({ kill: guard?.refused() ?? false }).catch((closeErr: unknown) => {
      if (!failed) opts.warn?.(`Warning: ${(closeErr as Error).message}`)
    })
  }
}

export async function renderPdf(
  executable: string,
  html: string,
  opts: RenderOptions
): Promise<Buffer> {
  return withPage(executable, html, opts, null, async (b, sessionId) => {
    // Streamed back in pieces (`IO.read`): a large PDF is never one huge message, and
    // printing has no fixed deadline — only the browser's liveness is checked.
    const { stream } = await b.sendLong<{ stream: string }>(
      'Page.printToPDF',
      {
        printBackground: true,
        paperWidth: A4.width,
        paperHeight: A4.height,
        marginTop: MARGIN_IN,
        marginBottom: MARGIN_IN,
        marginLeft: MARGIN_IN,
        marginRight: MARGIN_IN,
        transferMode: 'ReturnAsStream'
      },
      sessionId
    )
    const parts: Buffer[] = []
    for (;;) {
      const piece = await b.send<{ data: string; base64Encoded?: boolean; eof: boolean }>(
        'IO.read',
        { handle: stream, size: PDF_READ_BYTES },
        // A stream handle belongs to the session that opened it.
        sessionId
      )
      if (piece.data) parts.push(Buffer.from(piece.data, piece.base64Encoded ? 'base64' : 'utf8'))
      if (piece.eof) break
    }
    await b.send('IO.close', { handle: stream }, sessionId).catch(() => undefined)
    return Buffer.concat(parts)
  })
}

export async function renderPng(
  executable: string,
  html: string,
  opts: RenderOptions
): Promise<Buffer> {
  const viewport = { width: PNG_VIEWPORT, height: PNG_VIEWPORT, deviceScaleFactor: PNG_SCALE }
  return withPage(executable, html, opts, viewport, async (b, sessionId) => {
    const rect = (await evaluate<{ w: number; h: number }>(
      b,
      sessionId,
      PNG_MEASURE_EXPRESSION
    )) ?? {
      w: 400,
      h: 300
    }
    await b.send(
      'Emulation.setDeviceMetricsOverride',
      { width: rect.w, height: rect.h, deviceScaleFactor: PNG_SCALE, mobile: false },
      sessionId
    )
    // Let the resized layout paint (two frames; a timer in case frames are throttled).
    await evaluate(
      b,
      sessionId,
      'new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(() => r(true))); setTimeout(() => r(true), 200) })',
      true
    )
    const { data } = await b.sendLong<{ data: string }>(
      'Page.captureScreenshot',
      {
        format: 'png',
        clip: { x: 0, y: 0, width: rect.w, height: rect.h, scale: 1 },
        captureBeyondViewport: false
      },
      sessionId
    )
    return Buffer.from(data, 'base64')
  })
}
