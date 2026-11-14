// Desktop's artifact export: the person's own Electron renders the document the shared
// builder made (`@slayzone/task-artifacts/export-html`) and saves it where they pick.
// Reached from the renderer over the `app:export-artifact` IPC — the hub is not
// involved, so export behaves the same against a local or a remote hub.
import { readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { BrowserWindow, app, dialog, screen, shell } from 'electron'
import {
  EXPORT_READY_EXPRESSION,
  PNG_MEASURE_EXPRESSION,
  buildDocumentHtml,
  buildPngHtml,
  exportBaseName,
  needsMermaidScript,
  needsReadyWait
} from '@slayzone/task-artifacts/export-html'
import { canExportAsHtml, canExportAsPdf, canExportAsPng } from '@slayzone/task-contracts'
import type { RenderMode } from '@slayzone/task-contracts'
import type {
  ArtifactExportRequest,
  ArtifactExportResult
} from '@slayzone/platform/electron-bootstrap-contract'

const READY_TIMEOUT_MS = 10_000

// --- BrowserWindow rendering ---

/** Waits until a mermaid document has drawn; renders anyway after the timeout. */
async function waitForReady(offscreen: BrowserWindow, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await offscreen.webContents.executeJavaScript(EXPORT_READY_EXPRESSION)) return
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Render HTML to PDF via offscreen BrowserWindow. Returns the PDF buffer. */
export async function renderToPdf(html: string, waitReady: boolean): Promise<Buffer> {
  const tempPath = join(tmpdir(), `slayzone-pdf-${Date.now()}.html`)
  writeFileSync(tempPath, html, 'utf-8')

  let offscreen: BrowserWindow | null = null
  try {
    offscreen = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true }
    })
    await offscreen.loadFile(tempPath)

    if (waitReady) await waitForReady(offscreen)

    return Buffer.from(
      await offscreen.webContents.printToPDF({
        printBackground: true,
        // Margins left at printToPDF's default (1cm each side), which is what the
        // old `marginType: 'default'` selected; Electron 44's types dropped it.
        pageSize: 'A4'
      })
    )
  } finally {
    offscreen?.destroy()
    try {
      unlinkSync(tempPath)
    } catch {
      // Scratch file in the OS temp dir — if the unlink loses (already gone, or
      // the window still holds it on Windows) the OS reclaims it. Never worth
      // masking the export's own error with a cleanup failure.
    }
  }
}

/** Render HTML to PNG via offscreen BrowserWindow. Returns the PNG buffer. */
export async function renderToPng(html: string, waitReady: boolean): Promise<Buffer> {
  const tempPath = join(tmpdir(), `slayzone-png-${Date.now()}.html`)
  writeFileSync(tempPath, html, 'utf-8')

  let offscreen: BrowserWindow | null = null
  try {
    offscreen = new BrowserWindow({
      show: false,
      width: 2000,
      height: 2000,
      webPreferences: {
        // Render at the screen's pixel density (2x on Retina) so the PNG is as sharp
        // as the diagram on screen. Offscreen rendering used the primary display's
        // scale by default until Electron 42 made it 1.0.
        offscreen: { deviceScaleFactor: screen.getPrimaryDisplay().scaleFactor },
        nodeIntegration: false,
        contextIsolation: true
      }
    })
    await offscreen.loadFile(tempPath)

    if (waitReady) await waitForReady(offscreen)

    const { w, h } = (await offscreen.webContents.executeJavaScript(PNG_MEASURE_EXPRESSION)) as {
      w: number
      h: number
    }
    offscreen.setContentSize(w, h)
    await new Promise((r) => setTimeout(r, 100))

    const image = await offscreen.webContents.capturePage({ x: 0, y: 0, width: w, height: h })
    return image.toPNG()
  } finally {
    offscreen?.destroy()
    try {
      unlinkSync(tempPath)
    } catch {
      // Same as renderToPdf: the scratch file is disposable and the OS reclaims
      // it, so a cleanup failure must not replace the export's own error.
    }
  }
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
    defaultPath: join(app.getPath('downloads'), `${exportBaseName(title)}.${format}`),
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
  if (format === 'png') {
    const html = buildPngHtml(content, mode, title, mermaidJs)
    if (!html) return { ok: false, error: 'Failed to build PNG HTML (mermaid not available)' }
    bytes = await renderToPng(html, waitReady)
  } else {
    // An html artifact's PDF keeps its scripts, as desktop always rendered it (the
    // exported HTML file never does — the policy goes with it).
    const html = buildDocumentHtml(content, mode, title, mermaidJs, {
      artifactScripts: format === 'pdf'
    })
    bytes = format === 'pdf' ? await renderToPdf(html, waitReady) : html
  }

  writeFileSync(picked.filePath, bytes)
  shell.showItemInFolder(picked.filePath)
  return { ok: true }
}
