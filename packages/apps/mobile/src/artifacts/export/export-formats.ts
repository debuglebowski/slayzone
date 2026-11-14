/**
 * Which exports an artifact offers and what file each makes: desktop's rules
 * (`canExportAsPdf` / `Png` / `Html` of the render mode) and, per format, the type the
 * iOS share sheet files it under.
 */
import { NAME_MAX_BYTES, safeFileName, truncateUtf8 } from '@slayzone/task-artifacts/download-plan'
import { type ArtifactExportFormat, exportBaseName } from '@slayzone/task-artifacts/export-html'
import {
  canExportAsHtml,
  canExportAsPdf,
  canExportAsPng,
  type RenderMode
} from '@slayzone/task-contracts/types'
import { fileName } from '../file-cache'

export interface ExportFormatInfo {
  format: ArtifactExportFormat
  label: string
}

/** Desktop's order: PDF, PNG, HTML. */
const FORMATS: (ExportFormatInfo & { offered: (mode: RenderMode) => boolean })[] = [
  { format: 'pdf', label: 'PDF', offered: canExportAsPdf },
  { format: 'png', label: 'PNG', offered: canExportAsPng },
  { format: 'html', label: 'HTML', offered: canExportAsHtml }
]

/** The formats `mode` exports to; none for images and PDFs. */
export function exportFormatsOf(mode: RenderMode): ExportFormatInfo[] {
  return FORMATS.filter((f) => f.offered(mode)).map(({ format, label }) => ({ format, label }))
}

export function canExport(mode: RenderMode, format: ArtifactExportFormat): boolean {
  return FORMATS.some((f) => f.format === format && f.offered(mode))
}

export const formatLabel = (format: ArtifactExportFormat): string =>
  FORMATS.find((f) => f.format === format)?.label ?? format.toUpperCase()

/**
 * Per format: the file's extension, and its MIME type and UTI for `expo-sharing` (the
 * UTI is what iOS goes by; each one's preferred extension is the one the file has, so
 * the share sheet keeps the name as is).
 */
export const EXPORT_FILE_TYPES: Record<
  ArtifactExportFormat,
  { extension: string; mimeType: string; UTI: string }
> = {
  pdf: { extension: 'pdf', mimeType: 'application/pdf', UTI: 'com.adobe.pdf' },
  png: { extension: 'png', mimeType: 'image/png', UTI: 'public.png' },
  html: { extension: 'html', mimeType: 'text/html', UTI: 'public.html' }
}

/**
 * `plan.md` → `plan.pdf`: the title without its extension, legal as a file name, cut
 * to fit the 255-byte limit, and always ending in the format's extension — a title
 * of only dots or one that climbs (`../x`) included.
 */
export function exportFileName(title: string, format: ArtifactExportFormat): string {
  const ext = `.${EXPORT_FILE_TYPES[format].extension}`
  const base = fileName(exportBaseName(safeFileName(title, 'export')))
  return `${truncateUtf8(base, NAME_MAX_BYTES - ext.length)}${ext}`
}
