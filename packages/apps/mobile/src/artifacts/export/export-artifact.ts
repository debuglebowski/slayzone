/**
 * An artifact exported on the phone: the shared document (`@slayzone/task-artifacts/
 * export-html`, the same one desktop, the web shell and the CLI build) rendered here,
 * written to a file named after the artifact, and handed to the iOS share sheet (Save to
 * Files, AirDrop, Mail…).
 *
 * - HTML: the document, as is (a mermaid file keeps the mermaid build and draws itself
 *   wherever it is opened).
 * - PDF: the document printed by `expo-print`, on A4 with 1cm margins as desktop. Its
 *   WKWebView prints the moment the page has loaded, before any script has drawn, and
 *   has no navigation policy and no cancel, so nothing that needs a script is printed by
 *   it, and its HTML parser never sees the document (`printDocument`: it arrives as data,
 *   is parsed inert and moved in without what navigates). A mermaid diagram is drawn
 *   first in the hidden web view (`render-pages.ts`) and printed as the static SVG it
 *   became; an html artifact runs there in the viewer's sandbox (the view is unmounted
 *   when it goes silent, a page that loops included) and is drawn there page by page,
 *   each page written into the PDF as it comes (`pages-pdf.ts`, not expo-print: no page
 *   count makes the export hold more than a few pictures): the PDF is those page
 *   pictures, nothing else — no text to select or search, no links
 *   (what html2canvas can't draw is missing: a picture from a site that doesn't allow it
 *   to be read, a frame's content, a WebGL scene). An SVG with HTML in it that WebKit
 *   won't let be read back is drawn again with its HTML as text, and the person told.
 * - PNG: the SVG (a mermaid diagram drawn first, as for PDF) rasterised in the hidden web
 *   view; if WebKit won't read back mermaid's HTML labels, drawn again with text labels.
 *
 * Files go to `<caches>/slayzone-exports/`, emptied at each export (the share sheet is
 * done with the previous one by then). An export whose viewer closes stops at its next
 * step (`signal`): nothing is printed, written or shared after that. expo-print's own scratch PDFs (`<caches>/Print/`)
 * never pile up either: one that lands after its export gave up is removed when it
 * lands, and any left over (the app was killed mid-print) are swept when no print runs.
 */
import {
  type ArtifactExportFormat,
  buildDocumentHtml,
  buildDrawnMermaidDocumentHtml,
  needsMermaidScript
} from '@slayzone/task-artifacts/export-html'
import { RENDER_MODE_INFO, type RenderMode } from '@slayzone/task-contracts/types'
import { Directory, File, type FileHandle, FileMode, Paths } from 'expo-file-system'
import { printToFileAsync } from 'expo-print'
import { shareAsync } from 'expo-sharing'
import { canExport, EXPORT_FILE_TYPES, exportFileName, formatLabel } from './export-formats'
import { base64ToBytes, PagesPdf } from './pages-pdf'
import { printDocument } from './print-document'
import {
  type ExportPageSink,
  type ExportRenderPage,
  type ExportRenderReply,
  htmlRasterPage,
  mermaidSvgPage,
  pngCapturePage
} from './render-pages'

export const EXPORT_DIR = 'slayzone-exports'

/** A4 in points, and desktop's 1cm margins (`printToPDF`'s default). */
const A4 = { width: 595, height: 842 }
const MARGIN = 28

export interface ExportRequest {
  /** The text on screen: the working copy or the version being viewed. */
  content: string
  mode: RenderMode
  title: string
  format: ArtifactExportFormat
}

export interface ExportArtifactDeps {
  /**
   * Loads a page in the hidden web view; its reply (`use-export-renderer.ts`). An html
   * artifact's pages go to `sink` as they come.
   */
  render: (page: ExportRenderPage, sink?: ExportPageSink) => Promise<ExportRenderReply>
  /** mermaid's browser build (`page-assets.ts`). */
  mermaidScript: () => Promise<string>
  /** html2canvas's browser build (`page-assets.ts`): draws an html artifact's pages. */
  html2canvasScript: () => Promise<string>
  /** How long printing may take (default {@link EXPORT_PRINT_TIMEOUT_MS}). */
  printTimeoutMs?: number
  /**
   * Aborted when the viewer closes: the export stops at its next step — nothing printed,
   * written or shared after it (a share sheet would open over another screen).
   */
  signal?: AbortSignal
  /** Something the person should know about the file, said before the share sheet opens. */
  onNotice?: (notice: string) => void
}

/** What an export whose viewer closed fails with (nobody shows it). */
export const EXPORT_CANCELLED_MESSAGE = 'The export was cancelled: the viewer was closed.'

/** An html artifact's SVG labels drawn as plain text (`ExportRenderReply` `textLabels`). */
export const TEXT_LABELS_NOTICE =
  "Some labels in this page's drawings can't be exported as they are on this device, so they were drawn as plain text: they may look different from the page."

/** A print waiting on an unreachable image gives up long before this. */
export const EXPORT_PRINT_TIMEOUT_MS = 60_000

/** expo-print writes each PDF here before we move it. */
const PRINT_DIR = 'Print'
/** Prints an export still waits for: while any is, expo-print's folder is not swept. */
let printsInFlight = 0

/** The export folders of exports still running in this app: never swept. */
const liveExportDirs = new Set<string>()
let exportSeq = 0

/** Exports, opens the share sheet, and resolves with the file once the sheet is closed. */
export async function exportArtifact(
  request: ExportRequest,
  deps: ExportArtifactDeps
): Promise<string> {
  const { content, mode, title, format } = request
  if (!canExport(mode, format)) {
    const kind = RENDER_MODE_INFO[mode]?.label ?? mode
    throw new Error(`${formatLabel(format)} export isn't available for ${kind} artifacts.`)
  }
  if (!content.trim()) throw new Error('This artifact is empty: there is nothing to export.')
  stopIfClosed(deps)

  const { dir, file: target } = freshExportFile(exportFileName(title, format))
  return exportInto(target, request, deps).finally(() => liveExportDirs.delete(dir))
}

/** The viewer closed: the export stops here. */
function stopIfClosed(deps: ExportArtifactDeps): void {
  if (deps.signal?.aborted) throw new Error(EXPORT_CANCELLED_MESSAGE)
}

/**
 * `work`, unless the viewer closes first: then the export stops at once, whatever
 * `work` is still doing (a script read from disk, a render whose view is gone, a print).
 * Every step that waits goes through this, so a closed viewer never leaves the export
 * — and its folder, protected from sweeps while it runs — pending.
 */
function untilClosed<T>(work: Promise<T>, deps: ExportArtifactDeps): Promise<T> {
  const signal = deps.signal
  if (!signal) return work
  if (signal.aborted) {
    // Settled by nobody else: a late failure of `work` must not go unhandled.
    work.catch(() => undefined)
    return Promise.reject(new Error(EXPORT_CANCELLED_MESSAGE))
  }
  let onAbort: (() => void) | undefined
  const closed = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error(EXPORT_CANCELLED_MESSAGE))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([work, closed]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  })
}

async function exportInto(
  target: File,
  request: ExportRequest,
  deps: ExportArtifactDeps
): Promise<string> {
  const { content, mode, title, format } = request
  let notice: string | null = null
  switch (format) {
    case 'html': {
      const mermaid = needsMermaidScript(mode)
        ? await untilClosed(deps.mermaidScript(), deps)
        : null
      stopIfClosed(deps)
      target.create({ overwrite: true })
      await target.write(buildDocumentHtml(content, mode, title, mermaid, { standalone: true }))
      break
    }
    case 'pdf': {
      if (mode === 'html-preview') {
        if (await writeHtmlPagesPdf(target, content, title, deps)) notice = TEXT_LABELS_NOTICE
        break
      }
      const html = printDocument(
        mode === 'mermaid-preview'
          ? buildDrawnMermaidDocumentHtml(await drawMermaid(content, deps, true), title)
          : buildDocumentHtml(content, mode, title)
      )
      stopIfClosed(deps)
      if (printsInFlight === 0) sweepLeftoverPrints()
      printsInFlight++
      const job = printToFileAsync({
        html,
        width: A4.width,
        height: A4.height,
        margins: { left: MARGIN, right: MARGIN, top: MARGIN, bottom: MARGIN }
      })
      const printed = await untilClosed(
        withTimeout(
          job,
          deps.printTimeoutMs ?? EXPORT_PRINT_TIMEOUT_MS,
          'Printing the PDF took too long.'
        ),
        deps
      )
        // Done or given up: either way its file is no longer one to protect.
        .finally(() => printsInFlight--)
        .catch((err: unknown) => {
          // Given up (timed out, or the viewer closed): the PDF, if it ever lands, is
          // nobody's — removed when it does.
          job.then((late) => removeQuietly(new File(late.uri))).catch(() => undefined)
          throw err
        })
      if (deps.signal?.aborted) {
        removeQuietly(new File(printed.uri))
        stopIfClosed(deps)
      }
      await new File(printed.uri).move(target)
      break
    }
    case 'png': {
      const png = await drawPng(content, mode, title, deps)
      stopIfClosed(deps)
      target.create({ overwrite: true })
      await target.write(png, { encoding: 'base64' })
      break
    }
  }

  stopIfClosed(deps)
  if (notice) deps.onNotice?.(notice)
  const type = EXPORT_FILE_TYPES[format]
  await shareAsync(target.uri, {
    mimeType: type.mimeType,
    UTI: type.UTI,
    dialogTitle: target.name
  })
  return target.uri
}

/**
 * `<caches>/slayzone-exports/<this export>/<name>`: a folder per export, so a second
 * export (another viewer screen) never touches the first one's file. Earlier exports'
 * folders are swept — the share sheet is done with them — but never a live one.
 */
function freshExportFile(name: string): { dir: string; file: File } {
  const root = new Directory(Paths.cache, EXPORT_DIR)
  if (root.exists)
    for (const entry of root.list()) {
      // Each on its own: one that cannot be removed must not stop the export.
      try {
        if (!liveExportDirs.has(entry.uri)) entry.delete()
      } catch {
        // Left for the next sweep.
      }
    }
  const dir = new Directory(root, `${Date.now().toString(36)}-${++exportSeq}`)
  dir.create({ intermediates: true, idempotent: true })
  liveExportDirs.add(dir.uri)
  return { dir: dir.uri, file: new File(dir, name) }
}

/** expo-print's scratch PDFs left by an earlier run (no print is running now). */
function sweepLeftoverPrints(): void {
  const dir = new Directory(Paths.cache, PRINT_DIR)
  if (!dir.exists) return
  for (const entry of dir.list()) if (entry instanceof File) removeQuietly(entry)
}

function removeQuietly(entry: File): void {
  // One that cannot be removed must not fail the export; the next sweep retries.
  try {
    entry.delete()
  } catch {
    // Left for the next sweep.
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

/** The mermaid source as static SVG, drawn in the hidden web view. */
async function drawMermaid(
  source: string,
  deps: ExportArtifactDeps,
  htmlLabels: boolean
): Promise<string> {
  const script = await untilClosed(deps.mermaidScript(), deps)
  stopIfClosed(deps)
  const reply = await untilClosed(deps.render(mermaidSvgPage(source, script, { htmlLabels })), deps)
  if (reply.type === 'svg') return reply.svg
  throw new Error(
    `Couldn't draw the diagram: ${reply.type === 'error' ? reply.message : 'no diagram came back.'}`
  )
}

/**
 * An html artifact's PDF, written into `target`: its pages as its scripts drew them, from
 * the hidden web view, each written out as it comes (`pages-pdf.ts`) and none kept —
 * however many pages, the export holds about one. Resolves with whether an SVG's HTML
 * labels were drawn as plain text. A failure, or a closed viewer, leaves no partial PDF.
 */
async function writeHtmlPagesPdf(
  target: File,
  content: string,
  title: string,
  deps: ExportArtifactDeps
): Promise<boolean> {
  const script = await untilClosed(deps.html2canvasScript(), deps)
  stopIfClosed(deps)
  const pdf = openPagesPdf(target)
  try {
    const reply = await untilClosed(
      deps.render(htmlRasterPage(content, title, script), pdf.sink),
      deps
    )
    if (reply.type === 'error' && reply.code === 'tainted') {
      throw new Error(
        "This page draws something this device won't let the export read back, so it can't be made into a PDF here."
      )
    }
    if (reply.type !== 'pages') {
      throw new Error(
        `Couldn't render the page: ${reply.type === 'error' ? reply.message : 'no page came back.'}`
      )
    }
    if (reply.count !== pdf.pageCount) {
      throw new Error(`The export sent ${pdf.pageCount} of its ${reply.count} pages.`)
    }
    stopIfClosed(deps)
    pdf.finish()
    return reply.textLabels
  } catch (err) {
    pdf.discard()
    throw err
  }
}

/** The sheet the pictures go on: A4, desktop's 1cm margins (as the printed PDFs). */
const SHEET = { width: A4.width, height: A4.height, margin: MARGIN }

/**
 * `target` opened for a PDF of page pictures: `sink` takes the render's pages (a restart
 * starts the file again), `finish` completes and closes it, `discard` closes and removes
 * it. After either, a page that still comes is refused.
 */
function openPagesPdf(target: File): {
  sink: ExportPageSink
  readonly pageCount: number
  finish: () => void
  discard: () => void
} {
  let handle: FileHandle | null = null
  let pdf: PagesPdf
  let done = false
  const start = () => {
    handle?.close()
    target.create({ overwrite: true })
    const opened = target.open(FileMode.Truncate)
    handle = opened
    pdf = new PagesPdf({ write: (bytes) => opened.writeBytesSync(bytes) }, SHEET)
  }
  const close = () => {
    done = true
    try {
      handle?.close()
    } catch {
      // Closed already.
    }
    handle = null
  }
  start()
  return {
    sink: {
      page: (_index, base64) => {
        if (done) throw new Error(EXPORT_CANCELLED_MESSAGE)
        pdf.addPage(base64ToBytes(base64))
      },
      restart: () => {
        if (!done) start()
      }
    },
    get pageCount() {
      return pdf.pageCount
    },
    finish: () => {
      pdf.finish()
      close()
    },
    discard: () => {
      close()
      removeQuietly(target)
    }
  }
}

/** The PNG's bytes (base64) of an SVG artifact or a mermaid diagram. */
async function drawPng(
  content: string,
  mode: RenderMode,
  title: string,
  deps: ExportArtifactDeps
): Promise<string> {
  const mermaid = mode === 'mermaid-preview'
  const svg = mermaid ? await drawMermaid(content, deps, true) : content
  stopIfClosed(deps)
  let reply = await untilClosed(deps.render(pngCapturePage(svg, title)), deps)
  if (mermaid && reply.type === 'error' && reply.code === 'tainted') {
    const textSvg = await drawMermaid(content, deps, false)
    stopIfClosed(deps)
    reply = await untilClosed(deps.render(pngCapturePage(textSvg, title)), deps)
  }
  if (reply.type === 'png') return reply.base64
  if (reply.type === 'error' && reply.code === 'tainted') {
    throw new Error("This SVG embeds HTML, which can't be turned into a PNG on this device.")
  }
  throw new Error(
    `Couldn't make the PNG: ${reply.type === 'error' ? reply.message : 'no image came back.'}`
  )
}
