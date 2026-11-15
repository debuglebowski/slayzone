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
 *   it: a mermaid diagram is drawn first in the hidden web view (`render-pages.ts`) and
 *   printed as the static SVG it became; an html artifact is rendered there with its own
 *   scripts (the view is unmounted at the renderer's timeout, a page that loops
 *   included) and its DOM as drawn is printed with every script blocked.
 * - PNG: the SVG (a mermaid diagram drawn first, as for PDF) rasterised in the hidden web
 *   view; if WebKit won't read back mermaid's HTML labels, drawn again with text labels.
 *
 * Files go to `<caches>/slayzone-exports/`, emptied at each export (the share sheet is
 * done with the previous one by then). expo-print's own scratch PDFs (`<caches>/Print/`)
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
import { Directory, File, Paths } from 'expo-file-system'
import { printToFileAsync } from 'expo-print'
import { shareAsync } from 'expo-sharing'
import { canExport, EXPORT_FILE_TYPES, exportFileName, formatLabel } from './export-formats'
import {
  type ExportRenderPage,
  type ExportRenderReply,
  htmlPrintDocument,
  htmlSnapshotPage,
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
  /** Loads a page in the hidden web view; its reply (`use-export-renderer.ts`). */
  render: (page: ExportRenderPage) => Promise<ExportRenderReply>
  /** mermaid's browser build (`page-assets.ts`). */
  mermaidScript: () => Promise<string>
  /** How long printing may take (default {@link EXPORT_PRINT_TIMEOUT_MS}). */
  printTimeoutMs?: number
}

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

  const { dir, file: target } = freshExportFile(exportFileName(title, format))
  return exportInto(target, request, deps).finally(() => liveExportDirs.delete(dir))
}

async function exportInto(
  target: File,
  request: ExportRequest,
  deps: ExportArtifactDeps
): Promise<string> {
  const { content, mode, title, format } = request
  switch (format) {
    case 'html': {
      const mermaid = needsMermaidScript(mode) ? await deps.mermaidScript() : null
      target.create({ overwrite: true })
      await target.write(buildDocumentHtml(content, mode, title, mermaid, { standalone: true }))
      break
    }
    case 'pdf': {
      const html =
        mode === 'mermaid-preview'
          ? buildDrawnMermaidDocumentHtml(await drawMermaid(content, deps, true), title)
          : mode === 'html-preview'
            ? htmlPrintDocument(await renderHtml(content, title, deps))
            : buildDocumentHtml(content, mode, title)
      if (printsInFlight === 0) sweepLeftoverPrints()
      printsInFlight++
      const job = printToFileAsync({
        html,
        width: A4.width,
        height: A4.height,
        margins: { left: MARGIN, right: MARGIN, top: MARGIN, bottom: MARGIN }
      })
      const printed = await withTimeout(
        job,
        deps.printTimeoutMs ?? EXPORT_PRINT_TIMEOUT_MS,
        'Printing the PDF took too long.'
      )
        // Done or given up: either way its file is no longer one to protect.
        .finally(() => printsInFlight--)
        .catch((err: unknown) => {
          // Given up: the PDF, if it ever lands, is nobody's — removed when it does.
          job.then((late) => removeQuietly(new File(late.uri))).catch(() => undefined)
          throw err
        })
      await new File(printed.uri).move(target)
      break
    }
    case 'png': {
      const png = await drawPng(content, mode, title, deps)
      target.create({ overwrite: true })
      await target.write(png, { encoding: 'base64' })
      break
    }
  }

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
  const reply = await deps.render(
    mermaidSvgPage(source, await deps.mermaidScript(), { htmlLabels })
  )
  if (reply.type === 'svg') return reply.svg
  throw new Error(
    `Couldn't draw the diagram: ${reply.type === 'error' ? reply.message : 'no diagram came back.'}`
  )
}

/** An html artifact's DOM as its scripts drew it, inert, from the hidden web view. */
async function renderHtml(
  content: string,
  title: string,
  deps: ExportArtifactDeps
): Promise<string> {
  const reply = await deps.render(htmlSnapshotPage(content, title))
  if (reply.type === 'html') return reply.html
  throw new Error(
    `Couldn't render the page: ${reply.type === 'error' ? reply.message : 'no page came back.'}`
  )
}

/** The PNG's bytes (base64) of an SVG artifact or a mermaid diagram. */
async function drawPng(
  content: string,
  mode: RenderMode,
  title: string,
  deps: ExportArtifactDeps
): Promise<string> {
  const mermaid = mode === 'mermaid-preview'
  let reply = await deps.render(
    pngCapturePage(mermaid ? await drawMermaid(content, deps, true) : content, title)
  )
  if (mermaid && reply.type === 'error' && reply.code === 'tainted') {
    reply = await deps.render(pngCapturePage(await drawMermaid(content, deps, false), title))
  }
  if (reply.type === 'png') return reply.base64
  if (reply.type === 'error' && reply.code === 'tainted') {
    throw new Error("This SVG embeds HTML, which can't be turned into a PNG on this device.")
  }
  throw new Error(
    `Couldn't make the PNG: ${reply.type === 'error' ? reply.message : 'no image came back.'}`
  )
}
