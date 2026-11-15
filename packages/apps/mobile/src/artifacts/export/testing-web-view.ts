/**
 * Test helper: the export's hidden web view, emulated in jsdom — `render(page)` as
 * `useExportRenderer` does it, the page's scripts run for real. Suites using it run in
 * `./jest.jsdom-environment.js` (`@jest-environment`).
 *
 * - The page loads with `window.ReactNativeWebView` (the native bridge; or iOS's message
 *   handler, `nativeHandler`): every message carrying the page's token is a reply.
 * - jsdom does not load `srcdoc`: each `<iframe srcdoc>` of the page runs as a document of
 *   its own, whose `parent.postMessage` reaches the page as a message event from that
 *   frame (`event.source` is the frame's window), as WebKit delivers it.
 * - jsdom has no canvas: `getContext` answers with a 2D context that draws nothing, and
 *   `toDataURL` with a blank picture (`taint`: throws as WebKit does for a tainted one).
 * - jsdom has no layout: `onFrame` sees each frame the page adds itself (to stub sizes).
 */
import type * as Jsdom from 'jsdom'
import {
  type ExportRenderPage,
  type ExportRenderReply,
  parseExportRenderReply
} from './render-pages'

type JsdomApi = Pick<typeof Jsdom, 'JSDOM' | 'VirtualConsole'>

/** jsdom, from the suite's environment (`jest.jsdom-environment.js`: why). */
function jsdomApi(): JsdomApi {
  const api = (globalThis as { __jsdom?: JsdomApi }).__jsdom
  if (!api) throw new Error('Run this suite in ./jest.jsdom-environment.js (@jest-environment)')
  return api
}
export const { JSDOM, VirtualConsole } = jsdomApi()
type JSDOM = Jsdom.JSDOM
type JsdomWindow = JSDOM['window']

/** A 1x1 PNG. */
export const BLANK_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export interface WebViewOptions {
  /** A frame the page adds itself (not one in its markup), once it is in the page. */
  onFrame?: (frame: HTMLIFrameElement) => void
  /** Rows `getImageData` reads: all one colour unless this says the row has ink. */
  inkRow?: (y: number) => boolean
  /** Each picture `toDataURL` makes: its canvas's height. */
  onPicture?: (height: number) => void
  /** `toDataURL` throws a SecurityError (a tainted canvas). */
  taint?: boolean
  /** The bridge is iOS's message handler (`window.webkit.messageHandlers`). */
  nativeHandler?: boolean
  /** Fails the render if no reply came by then. */
  timeoutMs?: number
}

function stubCanvas(window: JsdomWindow, options: WebViewOptions): void {
  const proto = window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>
  proto.getContext = () => ({
    drawImage: () => undefined,
    fillRect: () => undefined,
    scale: () => undefined,
    getImageData: (_x: number, y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(Math.max(0, w * h * 4))
      for (let row = 0; row < h; row++) {
        if (options.inkRow?.(y + row)) data[row * w * 4 + 4] = 255
      }
      return { data, width: w, height: h }
    }
  })
  proto.toDataURL = function toDataURL(this: HTMLCanvasElement) {
    if (options.taint) throw new window.DOMException('The canvas is tainted.', 'SecurityError')
    options.onPicture?.(this.height)
    return `data:image/png;base64,${BLANK_PNG}`
  }
}

export interface HostPage {
  window: JsdomWindow
  /** Every reply the page posted (messages with its token), and every message at all. */
  replies: ExportRenderReply[]
  messages: string[]
  /** A message to the page as if from `source` (default: its artifact frame). */
  post: (data: unknown, source?: unknown) => void
  /** Errors the page's scripts threw. */
  errors: string[]
}

/** The page loaded on its own: its frames don't run (`post` speaks for them). */
export function loadHostPage(page: ExportRenderPage, options: WebViewOptions = {}): HostPage {
  const replies: ExportRenderReply[] = []
  const messages: string[] = []
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(String(error.stack ?? error)))
  const receive = (data: unknown) => {
    messages.push(String(data))
    const reply = parseExportRenderReply(String(data), page.token)
    if (reply) replies.push(reply)
  }
  const host = new JSDOM(page.html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      stubCanvas(window, options)
      const bridge = { postMessage: receive }
      const globals = window as unknown as Record<string, unknown>
      if (options.nativeHandler) {
        globals.webkit = { messageHandlers: { ReactNativeWebView: bridge } }
      } else {
        globals.ReactNativeWebView = bridge
      }
    }
  })
  const { document, MessageEvent, MutationObserver } = host.window
  new MutationObserver((records) => {
    for (const record of records)
      for (const node of Array.from(record.addedNodes)) {
        const frame = node as HTMLIFrameElement
        if (frame.localName === 'iframe' && !frame.hasAttribute('srcdoc')) options.onFrame?.(frame)
      }
  }).observe(document, { childList: true, subtree: true })
  const artifactFrame = document.querySelector('iframe[srcdoc]') as HTMLIFrameElement | null
  return {
    window: host.window,
    replies,
    messages,
    errors,
    post: (data, source = artifactFrame?.contentWindow) => {
      // Structured clone: the page gets a copy.
      const copy = JSON.parse(JSON.stringify(data)) as unknown
      host.window.dispatchEvent(
        new MessageEvent('message', { data: copy, source: source as Window | null })
      )
    }
  }
}

/** `render(page)`: the page and its sandboxed frames run; resolves with the first reply. */
export function webViewRender(
  page: ExportRenderPage,
  options: WebViewOptions = {}
): Promise<ExportRenderReply> {
  return new Promise((resolve, reject) => {
    const windows: JsdomWindow[] = []
    let done = false
    const finish = (settle: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearInterval(poll)
      for (const window of windows) window.close()
      settle()
    }
    const host = loadHostPage(page, options)
    windows.push(host.window)
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new Error(`no reply; page errors: ${host.errors.join('\n') || 'none'}`))
        ),
      options.timeoutMs ?? 10_000
    )
    const poll = setInterval(() => {
      const reply = host.replies[0]
      if (reply) finish(() => resolve(reply))
    }, 10)

    const frames = host.window.document.querySelectorAll<HTMLIFrameElement>('iframe[srcdoc]')
    for (const frame of Array.from(frames)) {
      const toHost = {
        postMessage: (data: unknown) => {
          if (!done && frame.isConnected) host.post(data, frame.contentWindow)
        }
      }
      const virtualConsole = new VirtualConsole()
      virtualConsole.on('jsdomError', (error) => host.errors.push(String(error.stack ?? error)))
      const child = new JSDOM(frame.getAttribute('srcdoc') ?? '', {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        virtualConsole,
        beforeParse(window) {
          stubCanvas(window, options)
          Object.defineProperty(window, 'parent', { configurable: true, get: () => toHost })
        }
      })
      windows.push(child.window)
    }
  })
}
