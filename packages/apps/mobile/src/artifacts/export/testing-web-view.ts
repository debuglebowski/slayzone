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
 *   `toDataURL` with a blank picture — in every frame, so the real html2canvas
 *   (`HTML2CANVAS_BUILD`) runs too. A canvas marked {@link TAINTED} (or every canvas, with
 *   `taint`) refuses `getImageData` and `toDataURL` with a SecurityError, and drawing it
 *   onto another canvas taints that one: WebKit's origin-clean flag.
 * - jsdom has no layout: `onFrame` sees each frame the page adds itself (to stub sizes),
 *   at any depth (html2canvas's copy of the stage too).
 * - jsdom loads no image: an `<img>` with a URL never completes, as on a server that
 *   never answers — but an inline one (`data:`) has (`onFrame` can say otherwise).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as Jsdom from 'jsdom'
import {
  collectExportReply,
  type ExportRenderMessage,
  type ExportRenderPage,
  type ExportRenderReply,
  parseExportRenderMessage
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

/** A canvas with this property set is tainted (see the stub canvas). */
export const TAINTED = '__slzTainted'

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
  /** Every canvas is tainted: `getImageData` and `toDataURL` throw a SecurityError. */
  taint?: boolean
  /** Each message the page posts to the app (with its token), as it posts it. */
  onMessage?: (message: ExportRenderMessage) => void
  /** The bridge is iOS's message handler (`window.webkit.messageHandlers`). */
  nativeHandler?: boolean
  /** Fails the render if no reply came by then. */
  timeoutMs?: number
  /** The page's window before its scripts run. */
  beforeScripts?: (window: JsdomWindow) => void
}

/** The html2canvas build the app ships (the config plugin's), as the page embeds it. */
export const HTML2CANVAS_BUILD: string = (() => {
  const plugin = require('../../../plugins/with-artifact-page-assets') as {
    HTML2CANVAS_BUNDLE_FILE: string
    PAGE_ASSETS: { file: string; build: (projectRoot: string) => string }[]
  }
  const asset = plugin.PAGE_ASSETS.find((a) => a.file === plugin.HTML2CANVAS_BUNDLE_FILE)
  if (!asset) throw new Error('no html2canvas build')
  return readFileSync(asset.build(join(__dirname, '..', '..', '..')), 'utf8')
})()

/** An inline picture (`data:` src) has loaded, as in WebKit: it waits on no server. */
function stubImages(window: JsdomWindow): void {
  const proto = window.HTMLImageElement.prototype
  const native = Object.getOwnPropertyDescriptor(proto, 'complete')?.get
  Object.defineProperty(proto, 'complete', {
    configurable: true,
    get(this: HTMLImageElement) {
      if (/^data:/i.test(this.getAttribute('src') ?? '') && !this.hasAttribute('srcset'))
        return true
      return native ? (native.call(this) as boolean) : false
    }
  })
}

function stubCanvas(window: JsdomWindow, options: WebViewOptions): void {
  stubImages(window)
  const proto = window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>
  const tainted = (canvas: unknown) =>
    options.taint || (canvas as Record<string, unknown> | null)?.[TAINTED] === true
  const refuse = () => {
    throw new window.DOMException('The canvas is tainted.', 'SecurityError')
  }
  proto.getContext = function getContext(this: HTMLCanvasElement) {
    const canvas = this
    const context: Record<string | symbol, unknown> = {
      canvas,
      drawImage: (source: unknown) => {
        if (tainted(source)) (canvas as unknown as Record<string, unknown>)[TAINTED] = true
      },
      getImageData: (_x: number, y: number, w: number, h: number) => {
        if (tainted(canvas)) refuse()
        const data = new Uint8ClampedArray(Math.max(0, w * h * 4))
        for (let row = 0; row < h; row++) {
          if (options.inkRow?.(y + row)) data[row * w * 4 + 4] = 255
        }
        return { data, width: w, height: h }
      },
      measureText: () => ({
        width: 1,
        actualBoundingBoxAscent: 1,
        actualBoundingBoxDescent: 1,
        fontBoundingBoxAscent: 1,
        fontBoundingBoxDescent: 1
      })
    }
    // Every other method draws nothing (a gradient or pattern takes colour stops).
    return new Proxy(context, {
      get: (target, key) =>
        key in target
          ? target[key]
          : typeof key === 'string'
            ? () => ({ addColorStop: () => undefined })
            : undefined,
      set: () => true
    })
  }
  proto.toDataURL = function toDataURL(this: HTMLCanvasElement) {
    if (tainted(this)) refuse()
    options.onPicture?.(this.height)
    return `data:image/png;base64,${BLANK_PNG}`
  }
}

export interface HostPage {
  window: JsdomWindow
  /**
   * Every reply the page posted (its messages with its token, put together as the app
   * does: `collectExportReply`), each such message, and every message at all.
   */
  replies: ExportRenderReply[]
  received: ExportRenderMessage[]
  messages: string[]
  /** A message to the page as if from `source` (default: its artifact frame). */
  post: (data: unknown, source?: unknown) => void
  /** Errors the page's scripts threw. */
  errors: string[]
}

/** The page loaded on its own: its frames don't run (`post` speaks for them). */
export function loadHostPage(page: ExportRenderPage, options: WebViewOptions = {}): HostPage {
  const replies: ExportRenderReply[] = []
  const received: ExportRenderMessage[] = []
  const messages: string[] = []
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(String(error.stack ?? error)))
  const take = collectExportReply()
  const receive = (data: unknown) => {
    messages.push(String(data))
    const message = parseExportRenderMessage(String(data), page.token, page.maxMessageChars)
    if (!message) return
    received.push(message)
    options.onMessage?.(message)
    const reply = take(message)
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
      options.beforeScripts?.(window)
    }
  })
  const { document, MessageEvent } = host.window
  // Each frame the page adds, and each frame added in one of those (html2canvas's copy).
  const watchFrames = (window: JsdomWindow) => {
    new window.MutationObserver((records) => {
      for (const record of records)
        for (const node of Array.from(record.addedNodes)) {
          const frame = node as HTMLIFrameElement
          if (frame.localName !== 'iframe' || frame.hasAttribute('srcdoc')) continue
          const inner = frame.contentWindow as unknown as JsdomWindow | null
          if (!inner) continue
          stubCanvas(inner, options)
          options.onFrame?.(frame)
          watchFrames(inner)
        }
    }).observe(window.document, { childList: true, subtree: true })
  }
  watchFrames(host.window)
  const artifactFrame = document.querySelector('iframe[srcdoc]') as HTMLIFrameElement | null
  return {
    window: host.window,
    replies,
    received,
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
