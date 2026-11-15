// The web shell's artifact export: the person's own browser renders the document the
// shared builder made (`@slayzone/task-artifacts/export-html`).
//   - PDF: the browser's print dialog (the person picks "Save as PDF"), opened by the
//     hub's export frame.
//   - PNG: the drawing rasterised onto a 2x canvas, then downloaded.
//   - HTML: the document itself, downloaded (mermaid's build inlined, like desktop's).
//
// An artifact is a document of its own and renders as written: an html report runs
// its scripts and loads its remote styles, markdown shows its remote images, a mermaid
// document draws itself with its inlined build. None of it may run with this page's
// origin, where the signed-in session lives. So a PDF is printed in the hub's EXPORT
// FRAME (hub export-frame.ts): a page with a policy of its own that sandboxes it to an
// opaque origin, framed here with `allow-scripts allow-modals` and no
// `allow-same-origin`. (This page's own policy could not host it anyway: a `srcdoc`
// frame inherits `script-src 'self'` and its `img-src`; `data:`/`blob:` frames are
// refused.) The documents that carry a policy of their own (markdown, code, mermaid's
// nonce'd one) keep it there.
//
// A PNG must be read back off a canvas, which needs the drawing in this origin: it is
// rasterised from a frame that runs NO script (sandboxed without `allow-scripts`; a
// `srcdoc` frame under this page's policy besides), and a mermaid diagram is drawn
// HERE first, by the app's own mermaid, as SVG.
import mermaidScriptUrl from 'mermaid/dist/mermaid.min.js?url'
import type {
  ArtifactExportRequest,
  ArtifactExportResult
} from '@slayzone/platform/electron-bootstrap-contract'
import {
  buildDocumentHtml,
  buildPngHtml,
  exportFileName
} from '@slayzone/task-artifacts/export-html'
import { canExportAsHtml, canExportAsPdf, canExportAsPng } from '@slayzone/task-contracts'
import type { RenderMode } from '@slayzone/task-contracts'
import { withExportDirective } from './mermaid-export-source'

/** Leftover print frame removed even if the browser never reports `afterprint`. */
const PRINT_FRAME_MAX_MS = 30 * 60_000
const FRAME_LOAD_TIMEOUT_MS = 15_000

/** The hub's export frame (hub export-frame.ts) and the protocol version it speaks. */
const EXPORT_FRAME_PATH = '/export-frame'
const EXPORT_FRAME_VERSION = 1
/** How long the frame waits for a document to load (remote images, fonts, a drawing). */
const EXPORT_FRAME_SETTLE_MS = 30_000
/** The shell's backstop on top of the frame's own wait. */
const EXPORT_FRAME_READY_MS = EXPORT_FRAME_SETTLE_MS + 15_000

const CAN_EXPORT = { pdf: canExportAsPdf, png: canExportAsPng, html: canExportAsHtml } as const

let mermaidScript: Promise<string> | null = null

/** mermaid's browser build, served by this shell as a static asset (HTML and PDF export). */
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
 * does (light theme, dagre; see mermaid-export-source.ts). `htmlLabels: false` draws
 * labels as SVG text instead of HTML (`<foreignObject>`), which a tainting browser can
 * rasterise. A diagram that does not parse rejects with mermaid's error.
 */
export async function drawMermaidSvg(
  code: string,
  opts: { htmlLabels: boolean } = { htmlLabels: true }
): Promise<string> {
  const { default: mermaid } = await import('mermaid')
  const parsed = await mermaid.parse(code)
  const source = withExportDirective(code, parsed ? parsed.config : {}, opts)
  const { svg } = await mermaid.render(`slz-export-mermaid-${++drawCount}`, source)
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

/** An invisible frame, laid out (measuring and printing need real layout), out of sight. */
function hiddenFrame(sandbox: string): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', sandbox)
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  frame.style.cssText =
    'position:fixed;left:-10000px;top:0;width:1200px;height:1200px;border:0;opacity:0;pointer-events:none'
  return frame
}

/**
 * Lay `html` out in a sandboxed, invisible frame and resolve with it once loaded. The
 * caller removes it.
 */
export function loadFrame(html: string, sandbox: string): Promise<HTMLIFrameElement> {
  return new Promise((resolve, reject) => {
    const frame = hiddenFrame(sandbox)
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

/** An id an artifact cannot guess (no `randomUUID`: it needs a secure context). */
function exportId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Print `html` through the browser's dialog from the hub's export frame (see the
 * module comment; the protocol is hub export-frame.ts's). Resolves once the dialog
 * closes. `waitForReady`: the document flags itself ready when it has drawn (mermaid).
 */
function printDocument(html: string, waitForReady: boolean): Promise<void> {
  const frame = hiddenFrame('allow-scripts allow-modals')
  const id = exportId()
  return new Promise<void>((resolve, reject) => {
    let stage: 'hello' | 'rendering' | 'printing' = 'hello'
    let timer = setTimeout(
      () => finish(new Error('The print frame did not load')),
      FRAME_LOAD_TIMEOUT_MS
    )
    const wait = (ms: number, onTimeout: () => void): void => {
      clearTimeout(timer)
      timer = setTimeout(onTimeout, ms)
    }
    function finish(err?: Error): void {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      frame.remove()
      if (err) reject(err)
      else resolve()
    }
    function onMessage(event: MessageEvent): void {
      // Only the frame speaks this protocol; anything else (another frame, a script
      // in this page) is not it. Its origin is opaque ("null"), so the source decides.
      if (event.source === null || event.source !== frame.contentWindow) return
      const data = event.data as Record<string, unknown> | null
      if (!data || typeof data !== 'object') return
      if (stage === 'hello') {
        if (!('slayzoneExportFrame' in data)) return
        if (data.slayzoneExportFrame !== EXPORT_FRAME_VERSION) {
          finish(new Error('This page is out of date. Reload it, then export again.'))
          return
        }
        stage = 'rendering'
        wait(EXPORT_FRAME_READY_MS, () => finish(new Error('The export did not finish loading')))
        // An opaque origin has no name to address: '*'. The frame is ours (its URL and
        // sandbox set here) and holds nothing but what this page sends it.
        frame.contentWindow?.postMessage(
          { slayzoneExport: id, html, waitForReady, deadlineMs: EXPORT_FRAME_SETTLE_MS },
          '*'
        )
        return
      }
      if (data.slayzoneExport !== id) return
      if (data.state === 'error') {
        finish(new Error(typeof data.message === 'string' ? data.message : 'Printing failed'))
      } else if (data.state === 'ready' && stage === 'rendering') {
        // The dialog is open now. Its Cancel is indistinguishable from Save; both end
        // the export. A browser that never reports afterprint still gets the frame back.
        stage = 'printing'
        wait(PRINT_FRAME_MAX_MS, () => finish())
      } else if (data.state === 'done') {
        finish()
      }
    }
    window.addEventListener('message', onMessage)
    frame.src = EXPORT_FRAME_PATH
    document.body.appendChild(frame)
  })
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
  const fileName = exportFileName(title, format)
  const isMermaid = mode === 'mermaid-preview'

  if (format === 'html') {
    const mermaidJs = isMermaid ? await loadMermaidScript().catch(() => null) : null
    saveBlob(
      new Blob([buildDocumentHtml(content, mode, title, mermaidJs, { standalone: true })], {
        type: 'text/html'
      }),
      fileName
    )
    return { ok: true }
  }

  if (format === 'pdf') {
    // Mermaid draws in the frame from its inlined build: the document every other
    // client renders, and the artifact's source never drawn in this origin.
    const mermaidJs = isMermaid ? await loadMermaidScript() : null
    await printDocument(buildDocumentHtml(content, mode, title, mermaidJs), isMermaid)
    return { ok: true }
  }

  const svg = isMermaid ? await deps.drawMermaid(content, { htmlLabels: true }) : null
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
