/**
 * @jest-environment ./jest.jsdom-environment.js
 */
// Review 7, #1–#2: the host page an html artifact is rendered in (`htmlRasterPage`), its
// script run for real in jsdom. The artifact's own frame (its snapshot script) is tested
// in render-pages.test.ts; the whole export in html-pdf-safety.test.ts.
import {
  EXPORT_RENDER_SOURCE,
  HTML_PAGE,
  HTML_RENDER_TIMEOUT_MS,
  HTML_STAGE_POLICY,
  htmlArtifactDocument,
  htmlRasterPage
} from './render-pages'
import {
  BLANK_PNG,
  type HostPage,
  JSDOM,
  loadHostPage,
  type WebViewOptions
} from './testing-web-view'

const PAPER_WHITE = 'white'

/** A fake html2canvas that records each call; a blank canvas of the asked size. */
const FAKE_HTML2CANVAS = `window.__calls = [];
window.html2canvas = function (element, options) {
  window.__calls.push({
    doc: element.ownerDocument,
    options: options,
    artifactFrame: !!document.getElementById('slz-export-artifact')
  });
  if (window.__fail) return Promise.reject(new Error(window.__fail));
  var canvas = document.createElement('canvas');
  canvas.width = Math.round(options.width * options.scale);
  canvas.height = Math.round(options.height * options.scale);
  return Promise.resolve(canvas);
};`

interface Call {
  doc: Document
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
    // Laid out at the printed page's width; more time than a diagram gets.
    expect(page.viewport).toEqual(HTML_PAGE)
    expect(HTML_PAGE).toEqual({ width: 539, height: 780 })
    expect(page.timeoutMs).toBe(HTML_RENDER_TIMEOUT_MS)
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
    expect(h.replies).toEqual([{ type: 'pages', pages: [BLANK_PNG] }])
    expect(callsOf(h)).toHaveLength(1)
    expect(callsOf(h)[0].doc.body.innerHTML).toBe('<p>drawn</p>')
    // The artifact's frame was gone before anything was drawn.
    expect(callsOf(h)[0].artifactFrame).toBe(false)
    expect(h.window.document.getElementById('slz-export-artifact')).toBeNull()
  })

  it("posts the pages with the page's token, through iOS's message handler", async () => {
    const { page, host: h } = host('x', { nativeHandler: true })
    h.post(SNAPSHOT('<p>drawn</p>'))
    await until(() => h.messages.length > 0)
    expect(h.messages).toHaveLength(1)
    expect(JSON.parse(h.messages[0])).toEqual({
      source: EXPORT_RENDER_SOURCE,
      token: page.token,
      type: 'pages',
      pages: [BLANK_PNG]
    })
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
