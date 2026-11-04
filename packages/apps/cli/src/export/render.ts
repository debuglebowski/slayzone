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
 */
import {
  EXPORT_READY_EXPRESSION,
  PNG_MEASURE_EXPRESSION
} from '@slayzone/task-artifacts/export-html'
import { type Browser, launchBrowser } from './cdp'

export interface RenderOptions {
  /** The document flags itself ready asynchronously (mermaid): wait for it. */
  waitReady: boolean
  /** Ready-wait budget; past it the page is captured as it stands (desktop parity). */
  readyTimeoutMs?: number
  /** Called when the ready flag never came. */
  warn?: (line: string) => void
}

const MM_PER_INCH = 25.4
const A4 = { width: 210 / MM_PER_INCH, height: 297 / MM_PER_INCH }
const MARGIN_IN = 10 / MM_PER_INCH
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

async function poll(
  b: Browser,
  sessionId: string,
  expression: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await evaluate<boolean>(b, sessionId, expression)) === true) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function withPage<T>(
  executable: string,
  html: string,
  opts: RenderOptions,
  viewport: { width: number; height: number; deviceScaleFactor: number } | null,
  fn: (b: Browser, sessionId: string) => Promise<T>
): Promise<T> {
  const b = await launchBrowser(executable)
  try {
    const { targetId } = await b.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank'
    })
    const { sessionId } = await b.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true
    })
    if (viewport) {
      await b.send('Emulation.setDeviceMetricsOverride', { ...viewport, mobile: false }, sessionId)
    }
    const { frameTree } = await b.send<{ frameTree: { frame: { id: string } } }>(
      'Page.getFrameTree',
      {},
      sessionId
    )
    await b.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, sessionId)
    // Subresources (images in markdown) loaded, then web fonts settled.
    await poll(b, sessionId, "document.readyState === 'complete'", 30_000)
    await evaluate(b, sessionId, 'document.fonts.ready.then(() => true)', true)
    if (opts.waitReady) {
      const ok = await poll(b, sessionId, EXPORT_READY_EXPRESSION, opts.readyTimeoutMs ?? 10_000)
      if (!ok) opts.warn?.('Warning: the diagram did not finish drawing in time; exporting as is.')
    }
    return await fn(b, sessionId)
  } finally {
    await b.close()
  }
}

export async function renderPdf(
  executable: string,
  html: string,
  opts: RenderOptions
): Promise<Buffer> {
  return withPage(executable, html, opts, null, async (b, sessionId) => {
    const { data } = await b.send<{ data: string }>(
      'Page.printToPDF',
      {
        printBackground: true,
        paperWidth: A4.width,
        paperHeight: A4.height,
        marginTop: MARGIN_IN,
        marginBottom: MARGIN_IN,
        marginLeft: MARGIN_IN,
        marginRight: MARGIN_IN
      },
      sessionId
    )
    return Buffer.from(data, 'base64')
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
    const { data } = await b.send<{ data: string }>(
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
