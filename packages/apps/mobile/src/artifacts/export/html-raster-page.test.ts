/**
 * @jest-environment ./jest.jsdom-environment.js
 */
// Review 7, #1–#2: the host page an html artifact is rendered in (`htmlRasterPage`), its
// script run for real in jsdom. The artifact's own frame (its snapshot script) is tested
// in render-pages.test.ts; the whole export in html-pdf-safety.test.ts.
import {
  EXPORT_RENDER_SOURCE,
  HTML_DRAW_TIMEOUT_MS,
  HTML_PAGE,
  HTML_RENDER_IDLE_MS,
  HTML_STAGE_POLICY,
  htmlArtifactDocument,
  htmlRasterPage
} from './render-pages'
import {
  BLANK_PNG,
  HTML2CANVAS_BUILD,
  type HostPage,
  JSDOM,
  loadHostPage,
  TAINTED,
  type WebViewOptions
} from './testing-web-view'

const PAPER_WHITE = 'white'

/** A fake html2canvas that records each call; a blank canvas of the asked size. */
const FAKE_HTML2CANVAS = `window.__calls = [];
window.html2canvas = function (element, options) {
  var doc = element.ownerDocument;
  window.__calls.push({
    doc: doc,
    html: doc.documentElement.outerHTML,
    options: options,
    artifactFrame: !!document.getElementById('slz-export-artifact')
  });
  if (window.__fail) return Promise.reject(new Error(window.__fail));
  var canvas = document.createElement('canvas');
  canvas.width = Math.round(options.width * options.scale);
  canvas.height = Math.round(options.height * options.scale);
  // WebKit: an SVG with HTML in it (<foreignObject>), drawn as html2canvas draws an SVG
  // (as an image), taints the canvas.
  if (doc.getElementsByTagName('foreignObject').length) canvas[${JSON.stringify(TAINTED)}] = true;
  return Promise.resolve(canvas);
};`

interface Call {
  doc: Document
  html: string
  options: Record<string, unknown>
  artifactFrame: boolean
}
const callsOf = (host: HostPage) => (host.window as unknown as { __calls: Call[] }).__calls

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const SNAPSHOT = (body: string) =>
  ({ type: 'slz-export-snapshot', html: `<html><head></head><body>${body}</body></html>` }) as const

/** The page loaded with a stage `heightCss` tall (jsdom has no layout). */
function host(content = '<h1>Report</h1>', options: WebViewOptions & { heightCss?: number } = {}) {
  const page = htmlRasterPage(content, 'r.html', FAKE_HTML2CANVAS)
  const loaded = loadHostPage(page, {
    ...options,
    onFrame: (frame) => {
      const height = options.heightCss
      if (height === undefined || !frame.contentWindow) return
      const proto = (frame.contentWindow as unknown as typeof globalThis).HTMLElement.prototype
      Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => height })
    }
  })
  return { page, host: loaded }
}

describe('htmlRasterPage: the host page', () => {
  it('holds the artifact only in a sandbox="allow-scripts" frame; the token only in its own script', () => {
    const content = '<h1>ARTIFACT</h1><script>draw()</script>'
    const page = htmlRasterPage(content, 'r.html', FAKE_HTML2CANVAS)
    const doc = new JSDOM(page.html).window.document
    const frames = Array.from(doc.querySelectorAll('iframe'))
    expect(frames).toHaveLength(1)
    // The viewer's sandbox: scripts, nothing else (no allow-modals: no dialogs; no
    // allow-same-origin: it can't reach the host; no popups, top navigation or forms).
    expect(frames[0].getAttribute('sandbox')).toBe('allow-scripts')
    expect(frames[0].getAttribute('srcdoc')).toBe(htmlArtifactDocument(content, 'r.html'))
    expect(frames[0].getAttribute('srcdoc')).not.toContain(page.token)
    // Ours first (listening before the frame exists), html2canvas then the host script.
    const scripts = Array.from(doc.querySelectorAll('script')).map((s) => s.textContent ?? '')
    expect(scripts).toHaveLength(2)
    expect(scripts[0]).toBe(FAKE_HTML2CANVAS)
    expect(scripts[1]).toContain(page.token)
    expect(doc.body.lastElementChild).toBe(frames[0])
    // Nothing of the artifact's outside the frame.
    frames[0].remove()
    expect(doc.documentElement.outerHTML).not.toContain('ARTIFACT')
    // Laid out at the printed page's width; more time without a word than a diagram gets.
    expect(page.viewport).toEqual(HTML_PAGE)
    expect(HTML_PAGE).toEqual({ width: 539, height: 780 })
    expect(page.idleTimeoutMs).toBe(HTML_RENDER_IDLE_MS)
    expect(htmlRasterPage(content, 'r.html', FAKE_HTML2CANVAS).token).not.toBe(page.token)
  })

  it('refuses an html2canvas build that could end its script element early', () => {
    expect(() => htmlRasterPage('x', 't', 'var a = "</script>"')).toThrow('script tag')
    expect(() => htmlRasterPage('x', 't', 'var a = "<!--"')).toThrow('script tag')
  })

  it("takes the snapshot from the artifact's own frame only, and only its first", async () => {
    const { host: h } = host()
    const other = h.window.document.createElement('iframe')
    h.window.document.body.appendChild(other)
    // Not the frame: the page itself, a frame inside or beside it, nobody.
    h.post(SNAPSHOT('<p>forged</p>'), h.window)
    h.post(SNAPSHOT('<p>forged</p>'), other.contentWindow)
    h.post(SNAPSHOT('<p>forged</p>'), null)
    // Not a snapshot.
    h.post({ type: 'other', html: '<p/>' })
    h.post('slz-export-snapshot')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(callsOf(h)).toEqual([])
    expect(h.messages).toEqual([])

    h.post(SNAPSHOT('<p>drawn</p>'))
    h.post(SNAPSHOT('<p>second</p>'))
    await until(() => h.replies.length > 0)
    expect(h.replies).toEqual([{ type: 'pages', pages: [BLANK_PNG], textLabels: false }])
    expect(callsOf(h)).toHaveLength(1)
    expect(callsOf(h)[0].doc.body.innerHTML).toBe('<p>drawn</p>')
    // The artifact's frame was gone before anything was drawn.
    expect(callsOf(h)[0].artifactFrame).toBe(false)
    expect(h.window.document.getElementById('slz-export-artifact')).toBeNull()
  })

  it("posts with the page's token, through iOS's message handler", async () => {
    const { page, host: h } = host('x', { nativeHandler: true })
    h.post(SNAPSHOT('<p>drawn</p>'))
    await until(() => h.replies.length > 0)
    const head = { source: EXPORT_RENDER_SOURCE, token: page.token }
    expect(h.messages.map((m) => JSON.parse(m))).toEqual([
      { ...head, type: 'progress' },
      { ...head, type: 'progress' },
      { ...head, type: 'page', index: 0, base64: BLANK_PNG },
      { ...head, type: 'pages-end', count: 1, textLabels: false }
    ])
  })

  // Review 9, L5: a long report on a slow phone took longer than one fixed budget, and
  // every page drawn was lost with it. Each page goes to the app as soon as it is cut,
  // each message a sign of progress (the app's idle timer).
  it('sends each page as soon as it is drawn, not all at the end', async () => {
    const callsAtPage: number[] = []
    const { host: h } = host('x', {
      heightCss: 10 * 780,
      onMessage: (message) => {
        if (message.type === 'page') callsAtPage.push(callsOf(h).length)
      }
    })
    h.post(SNAPSHOT('<p>long</p>'))
    await until(() => h.replies.length > 0)
    // Four pages a drawing: pages 0–2 went before the second drawing started.
    expect(callsAtPage).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 3])
    expect(h.received.map((m) => m.type)).toEqual([
      'progress',
      'progress',
      ...Array(10).fill('page'),
      'pages-end'
    ])
    const reply = h.replies[0]
    expect(reply.type === 'pages' && reply.pages.length).toBe(10)
  })

  it('draws the snapshot in a stage that runs nothing: sandboxed, a no-script policy first', async () => {
    const { host: h } = host()
    h.post(SNAPSHOT('<p>drawn</p>'))
    await until(() => h.replies.length > 0)
    const { doc, options } = callsOf(h)[0]
    const stage = Array.from(h.window.document.querySelectorAll('iframe')).find(
      (frame) => frame.contentDocument === doc
    )
    // Its origin (html2canvas reads it) and scripts on for html2canvas's own handlers —
    // nothing else: no allow-modals, popups, top navigation or forms.
    expect(stage?.getAttribute('sandbox')).toBe('allow-same-origin allow-scripts')
    const policy = doc.head.firstElementChild
    expect(policy?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(policy?.getAttribute('content')).toBe(HTML_STAGE_POLICY)
    expect(HTML_STAGE_POLICY).toContain("script-src 'none'")
    expect(HTML_STAGE_POLICY).toContain("default-src 'none'")
    expect(options).toMatchObject({
      x: 0,
      y: 0,
      width: HTML_PAGE.width,
      windowWidth: HTML_PAGE.width,
      windowHeight: HTML_PAGE.height,
      scale: 2,
      // Paper, whatever the app theme (the page's own PAPER).
      backgroundColor: PAPER_WHITE,
      useCORS: true
    })
  })

  // Review 7, #1: what a serialized snapshot can re-parse into. The host parses it once,
  // drops what can run, navigate, load a page or a plugin, and stages that tree.
  it('stages none of what a breakout can make live', async () => {
    const { host: h } = host()
    h.post(
      SNAPSHOT(
        [
          '<xmp></xmp><iframe src="https://evil.example/f"></iframe>',
          '<meta http-equiv="refresh" content="0;url=https://evil.example/r">',
          '<script>evil()</script><object data="https://evil.example/o"></object>',
          '<embed src="https://evil.example/e"><noscript><p>evil noscript</p></noscript>',
          '<template shadowrootmode="open"><iframe src="https://evil.example/t"></iframe></template>',
          '<link rel="preload" href="https://evil.example/p"><link rel="stylesheet" href="data:text/css,p{}">',
          '<img src="data:image/png;base64,QUJD" onerror="evil()">',
          '<a href=" java\tscript:evil()">link</a><a href="https://site.example/">site</a>',
          '<svg><script>evil()</script><a href="javascript:evil()"><text>label</text></a></svg>',
          '<div onclick="evil()" style="color: red">kept</div>',
          '<iframe srcdoc="<script>evil()</script>"></iframe><portal src="https://evil.example/x"></portal>'
        ].join('')
      )
    )
    await until(() => h.replies.length > 0)
    const doc = callsOf(h)[0].doc
    const tags = Array.from(doc.querySelectorAll('*')).map((el) => el.localName)
    for (const tag of [
      'script',
      'iframe',
      'object',
      'embed',
      'noscript',
      'template',
      'portal',
      'frameset'
    ]) {
      expect(tags).not.toContain(tag)
    }
    // The only meta is the stage's own policy.
    expect(Array.from(doc.querySelectorAll('meta')).map((m) => m.getAttribute('content'))).toEqual([
      HTML_STAGE_POLICY
    ])
    const staged = doc.documentElement.outerHTML
    expect(staged).not.toContain('evil')
    expect(staged).not.toMatch(/\son[a-z]+=/i)
    // What draws is kept.
    expect(staged).toContain('<div style="color: red">kept</div>')
    expect(staged).toContain('<img src="data:image/png;base64,QUJD">')
    expect(staged).toContain('<link rel="stylesheet" href="data:text/css,p{}">')
    expect(staged).toContain('<a>link</a><a href="https://site.example/">site</a>')
    expect(staged).toContain('<text>label</text>')
  }, 15_000)

  it('draws a few pages per html2canvas call, a page per picture', async () => {
    const heights: number[] = []
    const { host: h } = host('x', { heightCss: 10 * 780, onPicture: (px) => heights.push(px) })
    h.post(SNAPSHOT('<p>long</p>'))
    await until(() => h.replies.length > 0)
    // Four pages a call; the last page of a call that isn't the last starts the next one.
    expect(callsOf(h).map((c) => [c.options.y, c.options.height])).toEqual([
      [0, 3120],
      [2340, 3120],
      [4680, 3120]
    ])
    expect(heights).toEqual(Array(10).fill(1560))
    const reply = h.replies[0]
    expect(reply.type === 'pages' && reply.pages.length).toBe(10)
  })

  it('ends a page at a blank band near its bottom: no line cut in half', async () => {
    const heights: number[] = []
    // Ink on every row but 1400–1401 (pixels): the first page ends there.
    const { host: h } = host('x', {
      heightCss: 1600,
      inkRow: (y) => y !== 1400 && y !== 1401,
      onPicture: (px) => heights.push(px)
    })
    h.post(SNAPSHOT('<p>text</p>'))
    await until(() => h.replies.length > 0)
    expect(heights).toEqual([1402, 1560, 238])
  })

  it('a page with no blank band near its bottom is cut at the full page', async () => {
    const heights: number[] = []
    const { host: h } = host('x', {
      heightCss: 1600,
      inkRow: () => true,
      onPicture: (px) => heights.push(px)
    })
    h.post(SNAPSHOT('<p>text</p>'))
    await until(() => h.replies.length > 0)
    expect(heights).toEqual([1560, 1560, 80])
  })

  it('a drawing WebKit refuses to read back is a "tainted" error', async () => {
    const { host: h } = host('x', { taint: true })
    h.post(SNAPSHOT('<p>drawn</p>'))
    await until(() => h.replies.length > 0)
    expect(h.replies).toEqual([
      { type: 'error', code: 'tainted', message: 'The canvas is tainted.' }
    ])
    // No <foreignObject> to draw as text: nothing is tried again.
    expect(callsOf(h)).toHaveLength(1)
  })

  // Review 9, F4: an inline SVG with HTML in it (mermaid's HTML labels, many charts) taints
  // the canvas in WebKit. The page is staged again with each <foreignObject> as SVG
  // text at its place, drawn again, and the app is told the labels may differ.
  it('a drawing tainted by an SVG with HTML in it is drawn again with text labels', async () => {
    const { host: h } = host('x', { heightCss: 780 })
    h.post(
      SNAPSHOT(
        [
          '<p>chart</p><svg width="200" height="100">',
          '<g transform="translate(10,20)"><foreignObject x="4" y="6" width="40" height="20">',
          '<div xmlns="http://www.w3.org/1999/xhtml"><span>Start</span>  <b>here</b></div>',
          '</foreignObject></g>',
          '<foreignObject x="7" y="8"><div xmlns="http://www.w3.org/1999/xhtml">Corner</div></foreignObject>',
          '<foreignObject x="1" y="1" width="5" height="5"><div xmlns="http://www.w3.org/1999/xhtml"> </div></foreignObject>',
          '</svg>'
        ].join('')
      )
    )
    await until(() => h.replies.length > 0)
    expect(h.replies).toEqual([{ type: 'pages', pages: [BLANK_PNG], textLabels: true }])
    // The tainted drawing's pages (none here) are dropped, then all drawn again.
    expect(h.received.map((m) => m.type)).toEqual([
      'progress',
      'progress',
      'restart',
      'progress',
      'page',
      'pages-end'
    ])
    const [first, second] = callsOf(h)
    expect(callsOf(h)).toHaveLength(2)
    expect(first.html).toContain('<foreignObject')
    expect(second.html).not.toContain('foreignObject')
    const texts = Array.from(second.doc.getElementsByTagName('text'))
    expect(
      texts.map((t) => ({
        text: t.textContent,
        x: t.getAttribute('x'),
        y: t.getAttribute('y'),
        anchor: t.getAttribute('text-anchor'),
        baseline: t.getAttribute('dominant-baseline'),
        ns: t.namespaceURI
      }))
    ).toEqual([
      // Centred in its box, as mermaid centres a label in it.
      {
        text: 'Start here',
        x: '24',
        y: '16',
        anchor: 'middle',
        baseline: 'central',
        ns: 'http://www.w3.org/2000/svg'
      },
      // No box: at its corner.
      {
        text: 'Corner',
        x: '7',
        y: '8',
        anchor: null,
        baseline: 'hanging',
        ns: 'http://www.w3.org/2000/svg'
      }
    ])
    // In the group the label was in (its transform still applies); an empty one is dropped.
    expect(texts[0].parentElement?.getAttribute('transform')).toBe('translate(10,20)')
    expect(second.doc.querySelector('p')?.textContent).toBe('chart')
    // The first stage is gone: one stage frame left.
    const stages = Array.from(h.window.document.querySelectorAll('iframe')).filter(
      (f) => f.getAttribute('sandbox') === 'allow-same-origin allow-scripts'
    )
    expect(stages).toHaveLength(1)
  })

  it('still tainted with text labels (another picture): the "tainted" error', async () => {
    const { host: h } = host('x', { taint: true })
    h.post(
      SNAPSHOT(
        '<svg><foreignObject x="0" y="0"><div xmlns="http://www.w3.org/1999/xhtml">L</div></foreignObject></svg>'
      )
    )
    await until(() => h.replies.length > 0)
    expect(h.replies).toEqual([
      { type: 'error', code: 'tainted', message: 'The canvas is tainted.' }
    ])
    expect(callsOf(h)).toHaveLength(2)
  })

  // Review 9, F2: the web view lets every frame load its srcdoc (about:srcdoc) and
  // about:blank, nothing else. The artifact's frame loading another document once its own
  // has loaded (a reload, about:blank) is not the artifact: the export stops, nothing of it
  // is drawn.
  it("fails the export if the artifact's frame loads another document", async () => {
    const { host: h } = host()
    const frame = h.window.document.getElementById('slz-export-artifact') as HTMLIFrameElement
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50))
    // Another frame saying the artifact loaded is nobody: no guard yet.
    const other = h.window.document.createElement('iframe')
    h.window.document.body.appendChild(other)
    h.post({ type: 'slz-export-loaded' }, other.contentWindow)
    // The frame's own load event (any before its document says it loaded) is no navigation.
    frame.dispatchEvent(new h.window.Event('load'))
    await settle()
    h.post({ type: 'slz-export-loaded' })
    await settle()
    expect(h.messages).toEqual([])
    // A load after that: another document in its place.
    frame.dispatchEvent(new h.window.Event('load'))
    await until(() => h.replies.length > 0)
    expect(h.replies).toEqual([
      {
        type: 'error',
        code: 'render',
        message: 'The page opened another page in its place, so it was not exported.'
      }
    ])
    expect(h.window.document.getElementById('slz-export-artifact')).toBeNull()
    // Its snapshot, if one still came, is not taken.
    h.post(SNAPSHOT('<p>after</p>'), frame.contentWindow)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(callsOf(h)).toEqual([])
    expect(h.replies).toHaveLength(1)
  })

  it('a failed drawing, or a snapshot the frame could not take, is a render error', async () => {
    const { host: h } = host()
    ;(h.window as unknown as { __fail: string }).__fail = 'no layout'
    h.post(SNAPSHOT('<p>drawn</p>'))
    await until(() => h.replies.length > 0)
    expect(h.replies).toEqual([{ type: 'error', code: 'render', message: 'no layout' }])

    const { host: h2 } = host()
    h2.post({ type: 'slz-export-failed', message: 'cloneNode broke' })
    await until(() => h2.replies.length > 0)
    expect(h2.replies).toEqual([{ type: 'error', code: 'render', message: 'cloneNode broke' }])
  })
})

// Review 8, L10: the parser keeps a root attribute no DOM call can set (`=x`); the stage
// copies the root's attributes one by one.
it('stages a root attribute the DOM cannot set by skipping it, the others kept', async () => {
  const { host: h } = host()
  h.post({
    type: 'slz-export-snapshot',
    html: '<html lang="en" =x="1" data-theme="light"><head></head><body><p>drawn</p></body></html>'
  })
  await until(() => h.replies.length > 0)
  expect(h.replies).toEqual([{ type: 'pages', pages: [BLANK_PNG], textLabels: false }])
  const root = callsOf(h)[0].doc.documentElement
  expect(root.getAttribute('lang')).toBe('en')
  expect(root.getAttribute('data-theme')).toBe('light')
})

// Review 8, M2: html2canvas draws a copy of the stage and waits — with no end — for every
// image of the copy to load or fail, and for its fonts. A picture or font on a server that
// never answers held the export until the render's own timeout (90 s). Drawn with the
// html2canvas build the app ships (jsdom: no layout, a canvas that draws nothing).
describe('htmlRasterPage: what never loads (the real html2canvas)', () => {
  const STAGE_SANDBOX = 'allow-same-origin allow-scripts'
  const isStage = (frame: HTMLIFrameElement) => frame.getAttribute('sandbox') === STAGE_SANDBOX

  /** An image's picked URL, as WebKit picks it: a `<source>` of its picture, its srcset, its src. */
  function picked(img: HTMLImageElement): string {
    const parent = img.parentElement
    const source =
      parent?.localName === 'picture'
        ? Array.from(parent.children).find((el) => el.localName === 'source')
        : undefined
    const set = source?.getAttribute('srcset') ?? img.getAttribute('srcset')
    return set ? set.trim().split(/\s+/)[0] : (img.getAttribute('src') ?? '')
  }

  /**
   * Images made in a frame: complete unless `pending` (a server that never answers). A
   * node keeps its frame's prototype when html2canvas moves its copy into a frame of its own.
   */
  function images(
    frame: HTMLIFrameElement,
    pending: (url: string, img: HTMLImageElement) => boolean
  ) {
    const win = frame.contentWindow as unknown as typeof globalThis
    const proto = win.HTMLImageElement.prototype
    Object.defineProperty(proto, 'currentSrc', {
      configurable: true,
      get(this: HTMLImageElement) {
        return picked(this)
      }
    })
    Object.defineProperty(proto, 'complete', {
      configurable: true,
      get(this: HTMLImageElement) {
        const url = picked(this)
        return url === '' || !pending(url, this)
      }
    })
  }

  function realHost(options: WebViewOptions = {}) {
    const page = htmlRasterPage('x', 'r.html', HTML2CANVAS_BUILD)
    return { page, host: loadHostPage(page, options) }
  }

  const stageOf = (h: HostPage) =>
    Array.from(h.window.document.querySelectorAll('iframe')).find(isStage)?.contentDocument

  const NEVER = /never\.example/

  it('draws the page without the pictures that never loaded; lazy ones load', async () => {
    const { host: h } = realHost({ onFrame: (frame) => images(frame, (url) => NEVER.test(url)) })
    h.post(
      SNAPSHOT(
        [
          '<p>text</p>',
          '<img id="a" src="https://never.example/a.png" alt="A">',
          '<img id="b" srcset="https://never.example/b.png 2x">',
          '<picture id="p"><source srcset="https://never.example/c.png"><img id="d" src="https://never.example/d.png"></picture>',
          '<img id="e" src="https://ok.example/e.png" loading="lazy">',
          '<img id="f" src="data:image/png;base64,QUJD">'
        ].join('')
      )
    )
    await until(() => h.replies.length > 0, 20_000)
    expect(h.replies).toEqual([{ type: 'pages', pages: [BLANK_PNG], textLabels: false }])
    const stage = stageOf(h)
    if (!stage) throw new Error('no stage')
    const img = (id: string) => stage.getElementById(id) as HTMLImageElement
    // Never loaded: nothing left to wait on.
    for (const id of ['a', 'b', 'd']) {
      expect(img(id).hasAttribute('src')).toBe(false)
      expect(img(id).hasAttribute('srcset')).toBe(false)
    }
    expect(img('a').getAttribute('alt')).toBe('A')
    expect(stage.querySelector('#p source')).toBeNull()
    // Loaded: drawn. A lazy picture loads with the page (the stage is never scrolled).
    expect(img('e').getAttribute('src')).toBe('https://ok.example/e.png')
    expect(img('e').getAttribute('loading')).toBe('eager')
    expect(img('f').getAttribute('src')).toBe('data:image/png;base64,QUJD')
  }, 30_000)

  it('draws the page when a font never loads', async () => {
    // A font set whose fonts never finish: `ready` never settles (in every frame).
    const fontsNeverReady = (frame: HTMLIFrameElement) => {
      const win = frame.contentWindow as unknown as typeof globalThis
      const set = Object.create({
        get ready() {
          return new Promise(() => undefined)
        },
        get status() {
          return 'loading'
        }
      }) as object
      Object.defineProperty(win.Document.prototype, 'fonts', { configurable: true, get: () => set })
    }
    const { host: h } = realHost({ onFrame: fontsNeverReady })
    h.post(SNAPSHOT('<p style="font-family: Never, serif">text</p>'))
    await until(() => h.replies.length > 0, 20_000)
    expect(h.replies).toEqual([{ type: 'pages', pages: [BLANK_PNG], textLabels: false }])
  }, 30_000)

  it('a drawing that still waits on something fails at its own timeout, naming it', async () => {
    // Loaded in the stage, never in html2canvas's copy (a second request that hangs).
    const inCopy = (img: HTMLImageElement) =>
      !!img.ownerDocument.defaultView?.frameElement?.classList.contains('html2canvas-container')
    const { host: h } = realHost({
      onFrame: (frame) => images(frame, (url, img) => inCopy(img) && NEVER.test(url)),
      beforeScripts: (window) => {
        const wait = window.setTimeout.bind(window)
        const scaled = (fn: () => void, ms?: number) =>
          wait(fn, ms === HTML_DRAW_TIMEOUT_MS ? 300 : ms)
        ;(window as unknown as { setTimeout: unknown }).setTimeout = scaled
      }
    })
    h.post(SNAPSHOT('<p>text</p><img src="https://never.example/slow.png">'))
    await until(() => h.replies.length > 0, 20_000)
    expect(h.replies).toHaveLength(1)
    const reply = h.replies[0]
    expect(reply).toMatchObject({ type: 'error', code: 'render' })
    expect(reply.type === 'error' && reply.message).toContain('https://never.example/slow.png')
    expect(reply.type === 'error' && reply.message).toContain(`${HTML_DRAW_TIMEOUT_MS / 1000} s`)
  }, 30_000)
})
