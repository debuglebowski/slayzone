/**
 * An artifact exported on the phone: the shared document (`@slayzone/task-artifacts/
 * export-html`, the same one desktop, the web shell and the CLI build) rendered here,
 * written to a file named after the artifact, and handed to the iOS share sheet (Save to
 * Files, AirDrop, Mail…).
 *
 * - HTML: the document, as is (a mermaid file keeps the mermaid build and draws itself
 *   wherever it is opened).
 * - PDF: the document printed by `expo-print`, on A4 with 1cm margins as desktop. Its
 *   WKWebView prints the moment the page has loaded, before any script has drawn, so a
 *   mermaid diagram is drawn first in the hidden web view (`render-pages.ts`) and printed
 *   as the static SVG it became.
 * - PNG: the SVG (a mermaid diagram drawn first, as for PDF) rasterised in the hidden web
 *   view; if WebKit won't read back mermaid's HTML labels, drawn again with text labels.
 *
 * Files go to `<caches>/slayzone-exports/`, emptied at each export (the share sheet is
 * done with the previous one by then).
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
import { type ExportRenderReply, mermaidSvgPage, pngCapturePage } from './render-pages'

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
  render: (html: string) => Promise<ExportRenderReply>
  /** mermaid's browser build (`page-assets.ts`). */
  mermaidScript: () => Promise<string>
}

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

  const target = freshExportFile(exportFileName(title, format))
  switch (format) {
    case 'html': {
      const mermaid = needsMermaidScript(mode) ? await deps.mermaidScript() : null
      target.create({ overwrite: true })
      await target.write(buildDocumentHtml(content, mode, title, mermaid))
      break
    }
    case 'pdf': {
      const html =
        mode === 'mermaid-preview'
          ? buildDrawnMermaidDocumentHtml(await drawMermaid(content, deps, true), title)
          : buildDocumentHtml(content, mode, title)
      const printed = await printToFileAsync({
        html,
        width: A4.width,
        height: A4.height,
        margins: { left: MARGIN, right: MARGIN, top: MARGIN, bottom: MARGIN }
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

/** `<caches>/slayzone-exports/<name>`, the folder emptied of earlier exports. */
function freshExportFile(name: string): File {
  const dir = new Directory(Paths.cache, EXPORT_DIR)
  if (dir.exists) dir.delete()
  dir.create({ intermediates: true, idempotent: true })
  return new File(dir, name)
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
