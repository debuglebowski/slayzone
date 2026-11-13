// The web shell's artifact export: the person's own browser renders the document the
// shared builder made (`@slayzone/task-artifacts/export-html`).
//   - PDF: the browser's print dialog (the person picks "Save as PDF").
//   - PNG: the drawing rasterised onto a 2x canvas, then downloaded.
//   - HTML: the document itself, downloaded (mermaid's build inlined, like desktop's).
//
// NO SCRIPT RUNS IN THE RENDER FRAME. Two reasons, either sufficient:
//   - An artifact is arbitrary HTML (html-preview). Run with this page's origin it
//     could call the hub as the signed-in person; the frame is sandboxed without
//     `allow-scripts`, so its own scripts are inert.
//   - A `srcdoc` frame inherits this page's CSP (`script-src 'self'`, hub
//     security-headers.ts), which refuses inline scripts anyway.
// So mermaid diagrams are drawn HERE, by the app's own mermaid, and dropped into the
// document as SVG; the frame keeps `allow-same-origin` only so this page can lay it
// out, measure it and print it.
import mermaidScriptUrl from 'mermaid/dist/mermaid.min.js?url'
import type {
  ArtifactExportRequest,
  ArtifactExportResult
} from '@slayzone/platform/electron-bootstrap-contract'
import {
  buildDocumentHtml,
  buildDrawnMermaidDocumentHtml,
  buildPngHtml,
  exportBaseName
} from '@slayzone/task-artifacts/export-html'
import { canExportAsHtml, canExportAsPdf, canExportAsPng } from '@slayzone/task-contracts'
import type { RenderMode } from '@slayzone/task-contracts'

/** Leftover print frame removed even if the browser never reports `afterprint`. */
const PRINT_FRAME_MAX_MS = 30 * 60_000
const FRAME_LOAD_TIMEOUT_MS = 15_000

const CAN_EXPORT = { pdf: canExportAsPdf, png: canExportAsPng, html: canExportAsHtml } as const

let mermaidScript: Promise<string> | null = null

/** mermaid's browser build, served by this shell as a static asset (HTML export only). */
function loadMermaidScript(): Promise<string> {
  mermaidScript ??= fetch(mermaidScriptUrl)
    .then((res) => {
      if (!res.ok) throw new Error(`mermaid build: HTTP ${res.status}`)
      return res.text()
    })
    .catch((err: unknown) => {
      // A failed load is retried by the next export that needs it.
      mermaidScript = null
      throw err
    })
  return mermaidScript
}

let drawCount = 0

/**
 * Draw a mermaid diagram to SVG with the app's own mermaid, the way desktop's export
 * does (light theme, dagre). A directive rather than `initialize`: the in-app
 * MermaidBlock owns the global config (its dark/light theme), and a directive applies
 * to this one render only. `htmlLabels: false` draws labels as SVG text instead of
 * HTML (`<foreignObject>`), which a tainting browser can rasterise.
 */
export async function drawMermaidSvg(
  code: string,
  opts: { htmlLabels: boolean } = { htmlLabels: true }
): Promise<string> {
  const { default: mermaid } = await import('mermaid')
  const labels = opts.htmlLabels ? '' : ', "htmlLabels": false, "flowchart": {"htmlLabels": false}'
  const directive = `%%{init: {"theme": "default", "layout": "dagre"${labels}}}%%\n`
  const { svg } = await mermaid.render(`slz-export-mermaid-${++drawCount}`, directive + code)
  return svg
}

/**
 * The canvas a drawing went onto cannot be read back: WebKit (Safari) taints it when
 * the SVG holds HTML (`<foreignObject>`, as mermaid's default labels do).
 */
export class TaintedCanvasError extends Error {
  constructor() {
    super('The drawing could not be read back from the canvas')
    this.name = 'TaintedCanvasError'
  }
}

/** Hand `blob` to the browser as a download named `fileName`. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // The download has taken its copy by the time the click returns in every engine
  // that matters, but a revoke right away races Firefox; a minute is ample.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * Lay `html` out in a sandboxed, invisible, script-free frame and resolve with it once
 * loaded. The caller removes it.
 */
export function loadFrame(html: string, sandbox: string): Promise<HTMLIFrameElement> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', sandbox)
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    // Laid out (measuring and printing need real layout) but out of sight.
    frame.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1200px;height:1200px;border:0;opacity:0;pointer-events:none'
    const timer = setTimeout(() => {
      frame.remove()
      reject(new Error('Timed out laying out the export'))
    }, FRAME_LOAD_TIMEOUT_MS)
    frame.addEventListener(
      'load',
      () => {
        clearTimeout(timer)
        resolve(frame)
      },
      { once: true }
    )
    frame.srcdoc = html
    document.body.appendChild(frame)
  })
}

/** Print the document through the browser's dialog; resolves once it closes. */
async function printDocument(html: string): Promise<void> {
  const frame = await loadFrame(html, 'allow-same-origin allow-modals')
  const win = frame.contentWindow
  if (!win) {
    frame.remove()
    throw new Error('The print frame has no window')
  }
  // Fonts settle before the dialog snapshots the page.
  await frame.contentDocument?.fonts?.ready
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }
    // print() blocks until the dialog closes in Chromium; others report afterprint.
    const timer = setTimeout(done, PRINT_FRAME_MAX_MS)
    win.addEventListener('afterprint', done, { once: true })
    win.focus()
    win.print()
  })
  frame.remove()
}

/** Rasterise the PNG document's drawing at 2x, on white. */
async function rasterise(html: string): Promise<Blob> {
  const frame = await loadFrame(html, 'allow-same-origin')
  const drawn = drawFrame(frame)
  return drawn.finally(() => frame.remove())
}

async function drawFrame(frame: HTMLIFrameElement): Promise<Blob> {
  const doc = frame.contentDocument
  const root = doc?.body.firstElementChild
  const svg = doc?.querySelector('svg')
  if (!root || !svg) throw new Error('Nothing to draw')
  const rect = root.getBoundingClientRect()
  const w = Math.max(Math.ceil(rect.width), 10)
  const h = Math.max(Math.ceil(rect.height), 10)

  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(w))
  clone.setAttribute('height', String(h))
  clone.style.maxWidth = 'none'
  const xml = new XMLSerializer().serializeToString(clone)

  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('The drawing could not be rasterised'))
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`
  })
  const canvas = document.createElement('canvas')
  canvas.width = w * 2
  canvas.height = h * 2
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No 2D canvas')
  ctx.scale(2, 2)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  return new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('No image produced'))),
        'image/png'
      )
    } catch (err) {
      // WebKit throws SecurityError here for a tainted canvas.
      reject(
        err instanceof DOMException && err.name === 'SecurityError' ? new TaintedCanvasError() : err
      )
    }
  })
}

/** What a PNG export needs from the page; injectable so the fallback can be tested. */
export interface PngExportDeps {
  rasterise: (html: string) => Promise<Blob>
  drawMermaid: (code: string, opts: { htmlLabels: boolean }) => Promise<string>
}

const browserPngDeps: PngExportDeps = { rasterise, drawMermaid: drawMermaidSvg }

async function exportOrThrow(
  request: ArtifactExportRequest,
  deps: PngExportDeps
): Promise<ArtifactExportResult> {
  const { format, content, mode, title } = request
  if (!CAN_EXPORT[format](mode as RenderMode)) {
    return { ok: false, error: `Cannot export ${mode} as ${format.toUpperCase()}` }
  }
  const fileName = `${exportBaseName(title)}.${format}`
  const isMermaid = mode === 'mermaid-preview'

  if (format === 'html') {
    const mermaidJs = isMermaid ? await loadMermaidScript().catch(() => null) : null
    saveBlob(
      new Blob([buildDocumentHtml(content, mode, title, mermaidJs)], { type: 'text/html' }),
      fileName
    )
    return { ok: true }
  }

  const svg = isMermaid ? await deps.drawMermaid(content, { htmlLabels: true }) : null

  if (format === 'pdf') {
    // The dialog's own Cancel is indistinguishable from Save here; both end the export.
    await printDocument(
      svg !== null
        ? buildDrawnMermaidDocumentHtml(svg, title)
        : buildDocumentHtml(content, mode, title)
    )
    return { ok: true }
  }

  // A drawn mermaid diagram is just an SVG now.
  const png = (drawing: string): Promise<Blob> => {
    const html = buildPngHtml(drawing, 'svg-preview', title)
    return html ? deps.rasterise(html) : Promise.reject(new Error('Failed to build PNG HTML'))
  }
  const blob = await png(svg ?? content).catch(async (err: unknown) => {
    if (!(err instanceof TaintedCanvasError)) throw err
    // The same fallback the phone has: draw the diagram again with SVG text labels.
    if (!isMermaid)
      throw new Error("This SVG embeds HTML, which this browser can't turn into a PNG.")
    return png(await deps.drawMermaid(content, { htmlLabels: false }))
  })
  saveBlob(blob, fileName)
  return { ok: true }
}

export function exportArtifactInBrowser(
  request: ArtifactExportRequest,
  deps: PngExportDeps = browserPngDeps
): Promise<ArtifactExportResult> {
  return exportOrThrow(request, deps).catch((err: unknown) => ({
    ok: false as const,
    error: err instanceof Error ? err.message : String(err)
  }))
}
