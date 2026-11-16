// Desktop's artifact export: the person's own Electron renders the document the shared
// builder made (`@slayzone/task-artifacts/export-html`) and saves it where they pick.
// Reached from the renderer over the `app:export-artifact` IPC — the hub is not
// involved, so export behaves the same against a local or a remote hub.
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { BrowserWindow, app, dialog, screen, session, shell } from 'electron'
import type { Session, WebPreferences } from 'electron'
import {
  EXPORT_READY_EXPRESSION,
  PNG_MEASURE_EXPRESSION,
  buildDocumentHtml,
  buildPngHtml,
  exportFileName,
  needsMermaidScript,
  needsReadyWait
} from '@slayzone/task-artifacts/export-html'
import { canExportAsHtml, canExportAsPdf, canExportAsPng } from '@slayzone/task-contracts'
import type { RenderMode } from '@slayzone/task-contracts'
import type {
  ArtifactExportRequest,
  ArtifactExportResult
} from '@slayzone/platform/electron-bootstrap-contract'
import { writeFileWhole } from './client-save'

// --- The export window ---
//
// An artifact is arbitrary HTML (html-preview runs its own scripts, as on main). It is
// rendered where it can reach nothing of the app's:
//   - the export session, in memory and never the app's: no cookie, storage or cache
//     of the app's, and nothing it stores outlives the export (cleared after each);
//   - served from memory under a scheme of its own, so its origin is opaque — not
//     file:// (which would share the app's storage) and no file on disk to plant or race;
//   - sandboxed, no preload, no node; it can't open windows, navigate away, or get any
//     permission, and its alert/confirm/prompt are answered at once (ok, false, null)
//     instead of waiting for a person who never sees them.
// No fixed deadline caps a big document. The window is given up only when it can no
// longer finish: its renderer died, or stopped answering — for `unresponsiveMs` while
// loading, for `stallMs` while printing or capturing (a script that never yields,
// even one that starts looping only once printing begins).

const EXPORT_SCHEME = 'slz-export'
const EXPORT_PARTITION = 'slz-export'
const EXPORT_DOCUMENT_SANDBOX = 'sandbox allow-scripts'

/** How long an export window may take at each step. Overridable for tests. */
export interface ExportTimings {
  /** Longest wait for the page's subresources (a hung stylesheet); then it renders anyway. */
  loadWaitMs: number
  /** A renderer silent this long while loading (a script that never yields) fails it. */
  unresponsiveMs: number
  /**
   * A renderer silent this long while it prints or captures fails the export. Longer
   * than `unresponsiveMs`: laying out a huge document for print can keep the renderer
   * busy for a while without being stuck.
   */
  stallMs: number
  /** Longest wait for a mermaid diagram to flag itself drawn; then it renders anyway. */
  readyWaitMs: number
}

export const DEFAULT_EXPORT_TIMINGS: ExportTimings = {
  loadWaitMs: 60_000,
  unresponsiveMs: 60_000,
  stallMs: 5 * 60_000,
  readyWaitMs: 10_000
}

const ignore = (): void => undefined

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

class ExportWindowError extends Error {}

/** Documents being exported, by the URL each is served at. */
const exportDocuments = new Map<string, string>()
let sharedExportSession: Session | null = null

/**
 * The ONE session every export window uses: in memory (no `persist:` prefix), never
 * the app's, no permission, serving only the documents being exported. One, not one
 * per export: Electron can't destroy a session, so a session each grew the main
 * process with every export. Documents stay apart without it — each is served at its
 * own URL under a non-standard scheme, so each has an opaque origin (no storage, no
 * cookies), and the session's storage and cache are cleared after every export.
 */
function exportSession(): Session {
  if (sharedExportSession) return sharedExportSession
  const ses = session.fromPartition(EXPORT_PARTITION)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  // Nothing in an export window downloads (an artifact's `<a download>` would prompt a
  // save dialog with its own name once the window is gone).
  ses.on('will-download', (event) => event.preventDefault())
  ses.protocol.handle(EXPORT_SCHEME, (request) => {
    const html = exportDocuments.get(request.url)
    return html === undefined
      ? new Response(null, { status: 404 })
      : new Response(html, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            // The document is sandboxed: scripts run (html artifacts work as written)
            // but there are no modals — `print()`, which opened macOS's app-modal print
            // panel and froze the main process, and alert/confirm/prompt are no-ops,
            // in every frame it makes too — and no downloads, popups, forms or top
            // navigation. The export's own print is the browser's printToPDF, which no
            // sandbox flag touches.
            'content-security-policy': EXPORT_DOCUMENT_SANDBOX
          }
        })
  })
  sharedExportSession = ses
  return ses
}

/** Serve `html` for one export; returns its URL. */
function serveDocument(html: string): string {
  const url = `${EXPORT_SCHEME}://${randomUUID()}/`
  exportDocuments.set(url, html)
  return url
}

function retireDocument(ses: Session, url: string): void {
  exportDocuments.delete(url)
  ses.clearStorageData().catch(ignore)
  ses.clearCache().catch(ignore)
}

/**
 * Open `html` in an isolated hidden window, hand it to `render`, always destroy it.
 * `render` gets a `step` wrapper that fails fast when the renderer dies or hangs.
 */
async function withExportWindow<T>(
  html: string,
  size: { width: number; height: number },
  offscreen: WebPreferences['offscreen'],
  timings: ExportTimings,
  render: (
    win: BrowserWindow,
    watched: <R>(p: Promise<R>) => Promise<R>,
    probe: <R>(code: string) => Promise<R>
  ) => Promise<T>
): Promise<T> {
  const ses = exportSession()
  const documentUrl = serveDocument(html)
  const win = new BrowserWindow({
    show: false,
    ...size,
    webPreferences: {
      offscreen,
      session: ses,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: false,
      spellcheck: false,
      // Electron answers a JS dialog itself (alert: ok, confirm: false, prompt: null)
      // instead of showing it: nobody sees this window, so a dialog would wait forever.
      ...({ disableDialogs: true } as WebPreferences)
    }
  })
  const wc = win.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e) => e.preventDefault())
  wc.on('will-redirect', (e) => e.preventDefault())

  let broken = false
  let fail: (err: Error) => void = ignore
  const failed = new Promise<never>((_, reject) => {
    fail = (err) => {
      broken = true
      reject(err)
    }
  })
  failed.catch(ignore)
  const hung = (): void => fail(new ExportWindowError('The document stopped responding'))
  wc.on('render-process-gone', (_e, details) =>
    fail(new ExportWindowError(`The export renderer stopped (${details.reason})`))
  )
  wc.on('unresponsive', hung)

  const step = <R>(p: Promise<R>): Promise<R> => Promise.race([p, failed])
  // Ask the page something; no answer within `unresponsiveMs` means it is hung.
  const probe = <R>(code: string): Promise<R> => {
    const timer = setTimeout(hung, timings.unresponsiveMs)
    return step(wc.executeJavaScript(code) as Promise<R>).finally(() => clearTimeout(timer))
  }

  /**
   * A long step (print, capture) watched for a stall: the page is asked a trivial
   * question every second; one left unanswered for `stallMs` means a script holds the
   * renderer forever, and the export fails instead of waiting with it.
   */
  const watched = <R>(p: Promise<R>): Promise<R> => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const watch = (): void => {
      timer = setTimeout(() => {
        if (settled || wc.isDestroyed()) return
        const stall = setTimeout(hung, timings.stallMs)
        wc.executeJavaScript('1')
          .catch(ignore)
          .finally(() => {
            clearTimeout(stall)
            if (!settled) watch()
          })
      }, 1_000)
    }
    watch()
    return step(p).finally(() => {
      settled = true
      clearTimeout(timer)
    })
  }

  try {
    // Our own load events, not loadURL's promise: that one rejects when the artifact
    // tries to navigate away (refused above), though the document itself loads fine.
    const loading = new Promise<void>((resolve, reject) => {
      wc.once('did-finish-load', () => resolve())
      wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
        if (isMainFrame && url === documentUrl && code !== -3)
          reject(new ExportWindowError(`The export document failed to load (${description})`))
      })
    })
    loading.catch(ignore)
    wc.loadURL(documentUrl).catch(ignore)
    // A stylesheet that never arrives doesn't block the export: render what loaded.
    let loadWait: NodeJS.Timeout | undefined
    await step(
      Promise.race([
        loading,
        new Promise<void>((r) => {
          loadWait = setTimeout(r, timings.loadWaitMs)
        })
      ])
    ).finally(() => clearTimeout(loadWait))
    await probe('1')
    return await render(win, watched, probe)
  } finally {
    if (!win.isDestroyed()) {
      // A hung renderer is stopped, not left spinning.
      if (broken && !wc.isDestroyed()) wc.forcefullyCrashRenderer()
      win.destroy()
    }
    retireDocument(ses, documentUrl)
  }
}

/** Waits until a mermaid document has drawn; renders anyway after `readyWaitMs`. */
async function waitForReady(
  probe: <R>(code: string) => Promise<R>,
  timings: ExportTimings
): Promise<void> {
  const deadline = Date.now() + timings.readyWaitMs
  while (Date.now() < deadline) {
    if (await probe<boolean>(EXPORT_READY_EXPRESSION)) return
    await delay(100)
  }
}

/** Render HTML to PDF in an isolated hidden window. Returns the PDF buffer. */
export function renderToPdf(
  html: string,
  waitReady: boolean,
  timings: ExportTimings = DEFAULT_EXPORT_TIMINGS
): Promise<Buffer> {
  return withExportWindow(
    html,
    { width: 800, height: 600 },
    true,
    timings,
    async (win, watched, probe) => {
      if (waitReady) await waitForReady(probe, timings)
      return Buffer.from(
        await watched(
          win.webContents.printToPDF({
            printBackground: true,
            // Margins left at printToPDF's default (1cm each side), which is what the
            // old `marginType: 'default'` selected; Electron 44's types dropped it.
            pageSize: 'A4'
          })
        )
      )
    }
  )
}

/** Render HTML to PNG in an isolated hidden window. Returns the PNG buffer. */
export function renderToPng(
  html: string,
  waitReady: boolean,
  timings: ExportTimings = DEFAULT_EXPORT_TIMINGS
): Promise<Buffer> {
  return withExportWindow(
    html,
    { width: 2000, height: 2000 },
    // Render at the screen's pixel density (2x on Retina) so the PNG is as sharp as
    // the diagram on screen. Offscreen rendering used the primary display's scale by
    // default until Electron 42 made it 1.0.
    { deviceScaleFactor: screen.getPrimaryDisplay().scaleFactor },
    timings,
    async (win, watched, probe) => {
      if (waitReady) await waitForReady(probe, timings)
      const { w, h } = await probe<{ w: number; h: number }>(PNG_MEASURE_EXPRESSION)
      win.setContentSize(w, h)
      await delay(100)
      const image = await watched(win.webContents.capturePage({ x: 0, y: 0, width: w, height: h }))
      return image.toPNG()
    }
  )
}

// --- The export a person asked for ---

const FORMATS = {
  pdf: { label: 'PDF', canExport: canExportAsPdf },
  png: { label: 'PNG', canExport: canExportAsPng },
  html: { label: 'HTML', canExport: canExportAsHtml }
} as const

/** The renderer's request, checked: it crosses the IPC boundary untyped. */
export function parseArtifactExportRequest(raw: unknown): ArtifactExportRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.format !== 'pdf' && r.format !== 'png' && r.format !== 'html') return null
  if (typeof r.content !== 'string' || typeof r.mode !== 'string') return null
  if (typeof r.title !== 'string') return null
  return { format: r.format, content: r.content, mode: r.mode, title: r.title }
}

export interface DesktopArtifactExportDeps {
  /** mermaid's standalone browser build, copied next to the app's own output. */
  mermaidScriptPath: string
  /** Export window timings (tests shorten them). */
  timings?: ExportTimings
}

/**
 * Ask where to save, render, write, reveal. `parent` hosts the save sheet (null =
 * an app-modal dialog).
 */
export async function exportArtifactOnDesktop(
  parent: BrowserWindow | null,
  rawRequest: unknown,
  deps: DesktopArtifactExportDeps
): Promise<ArtifactExportResult> {
  const request = parseArtifactExportRequest(rawRequest)
  if (!request) return { ok: false, error: 'Invalid export request' }
  const { format, content, mode, title } = request
  const spec = FORMATS[format]
  if (!spec.canExport(mode as RenderMode)) {
    return { ok: false, error: `Cannot export ${mode} as ${spec.label}` }
  }

  const options = {
    title: `Download as ${spec.label}`,
    defaultPath: join(app.getPath('downloads'), exportFileName(title, format)),
    filters: [{ name: spec.label, extensions: [format] }]
  }
  const picked = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }

  let mermaidJs: string | null = null
  if (needsMermaidScript(mode)) {
    try {
      mermaidJs = readFileSync(deps.mermaidScriptPath, 'utf-8')
    } catch {
      // Missing bundle: PDF/HTML fall back to the diagram's source, PNG reports it.
    }
  }

  const waitReady = needsReadyWait(mode)
  let bytes: Buffer | string
  try {
    if (format === 'png') {
      const html = buildPngHtml(content, mode, title, mermaidJs)
      if (!html) return { ok: false, error: 'Failed to build PNG HTML (mermaid not available)' }
      bytes = await renderToPng(html, waitReady, deps.timings)
    } else {
      // The HTML file is the document as main exported it (no policy); a PDF render
      // keeps the policy for markdown/code/mermaid (html artifacts render as written).
      const html = buildDocumentHtml(content, mode, title, mermaidJs, {
        standalone: format === 'html'
      })
      bytes = format === 'pdf' ? await renderToPdf(html, waitReady, deps.timings) : html
    }
  } catch (err) {
    // A document that hung or crashed its renderer is an export failure, reported.
    if (err instanceof ExportWindowError) return { ok: false, error: err.message }
    throw err
  }

  // Whole or not at all: a failed write never leaves a cut file where theirs was.
  await writeFileWhole(
    picked.filePath,
    typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : bytes
  )
  shell.showItemInFolder(picked.filePath)
  return { ok: true }
}
