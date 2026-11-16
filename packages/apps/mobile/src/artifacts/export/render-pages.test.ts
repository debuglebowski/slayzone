import { runInNewContext } from 'node:vm'
import {
  EXPORT_RENDER_SOURCE,
  type ExportRenderPage,
  type ExportRenderReply,
  collectExportReply,
  EXPORT_MESSAGE_MAX_CHARS,
  HTML_MESSAGE_MAX_CHARS,
  HTML_PRINT_POLICY,
  HTML_SETTLE,
  htmlArtifactDocument,
  htmlPrintDocument,
  htmlRasterPage,
  mermaidSvgPage,
  parseExportRenderMessage,
  pngCapturePage
} from './render-pages'

/** The page's inline scripts, in order (what the web view runs). */
function scriptsOf(html: string): string[] {
  return [...html.matchAll(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/g)].map((m) => m[2])
}

/** The nonce the page's policy allows; every script must carry it. */
function policyNonce(html: string): string {
  const m = /script-src 'nonce-([^']+)'/.exec(html)
  if (!m) throw new Error('no nonce in the policy')
  return m[1]
}

/** Runs the page's scripts against `globals`; resolves with the first reply it posts. */
function runPage(
  page: ExportRenderPage,
  globals: Record<string, unknown>
): Promise<ExportRenderReply> {
  return new Promise((resolve, reject) => {
    const take = collectExportReply()
    const context = {
      ...globals,
      window: {
        ReactNativeWebView: {
          postMessage: (data: string) => {
            const message = parseExportRenderMessage(data, page.token)
            if (!message) reject(new Error(`unparseable reply: ${data}`))
            const reply = message && take(message)
            if (reply) resolve(reply)
          }
        }
      }
    }
    for (const script of scriptsOf(page.html)) runInNewContext(script, context)
  })
}

describe('parseExportRenderMessage', () => {
  const TOKEN = 'page-token'
  const msg = (body: object) =>
    JSON.stringify({ source: EXPORT_RENDER_SOURCE, token: TOKEN, ...body })

  it('reads the replies, and the steps of an html render', () => {
    expect(parseExportRenderMessage(msg({ type: 'svg', svg: '<svg/>' }), TOKEN)).toEqual({
      type: 'svg',
      svg: '<svg/>'
    })
    expect(
      parseExportRenderMessage(msg({ type: 'png', base64: 'AAA', width: 20, height: 10 }), TOKEN)
    ).toEqual({ type: 'png', base64: 'AAA', width: 20, height: 10 })
    expect(
      parseExportRenderMessage(msg({ type: 'error', code: 'tainted', message: 'no' }), TOKEN)
    ).toEqual({ type: 'error', code: 'tainted', message: 'no' })
    // Review 9, L5: an html artifact's pages come one message each.
    expect(parseExportRenderMessage(msg({ type: 'progress' }), TOKEN)).toEqual({
      type: 'progress'
    })
    expect(
      parseExportRenderMessage(msg({ type: 'page', index: 0, base64: 'QUJD' }), TOKEN)
    ).toEqual({ type: 'page', index: 0, base64: 'QUJD' })
    expect(parseExportRenderMessage(msg({ type: 'restart' }), TOKEN)).toEqual({
      type: 'restart'
    })
    expect(
      parseExportRenderMessage(msg({ type: 'pages-end', count: 2, textLabels: true }), TOKEN)
    ).toEqual({ type: 'pages-end', count: 2, textLabels: true })
  })

  it('ignores anything else: not JSON, another source, a malformed message', () => {
    expect(parseExportRenderMessage('not json', TOKEN)).toBeNull()
    expect(
      parseExportRenderMessage(JSON.stringify({ type: 'svg', svg: '<svg/>', token: TOKEN }), TOKEN)
    ).toBeNull()
    expect(parseExportRenderMessage(msg({ type: 'svg' }), TOKEN)).toBeNull()
    // All the pages at once is no message: they come one by one.
    expect(parseExportRenderMessage(msg({ type: 'pages', pages: ['QUJD'] }), TOKEN)).toBeNull()
    // A page is base64 and nothing else, at a whole-number place.
    expect(
      parseExportRenderMessage(msg({ type: 'page', index: 0, base64: '<img>' }), TOKEN)
    ).toBeNull()
    expect(parseExportRenderMessage(msg({ type: 'page', index: 0, base64: 1 }), TOKEN)).toBeNull()
    expect(
      parseExportRenderMessage(msg({ type: 'page', index: 0.5, base64: 'QUJD' }), TOKEN)
    ).toBeNull()
    expect(
      parseExportRenderMessage(msg({ type: 'page', index: -1, base64: 'QUJD' }), TOKEN)
    ).toBeNull()
    expect(
      parseExportRenderMessage(msg({ type: 'pages-end', count: '2', textLabels: false }), TOKEN)
    ).toBeNull()
    expect(parseExportRenderMessage(msg({ type: 'pages-end', count: 2 }), TOKEN)).toBeNull()
    // The old snapshot reply is no reply.
    expect(parseExportRenderMessage(msg({ type: 'html', html: '<p/>' }), TOKEN)).toBeNull()
    expect(
      parseExportRenderMessage(msg({ type: 'png', base64: 'A', width: '1' }), TOKEN)
    ).toBeNull()
    expect(
      parseExportRenderMessage(msg({ type: 'error', code: 'boom', message: '' }), TOKEN)
    ).toBeNull()
    expect(parseExportRenderMessage(msg({ type: 'other' }), TOKEN)).toBeNull()
  })

  // Review 6, #4: an html artifact's own scripts run in the render; a message counts only
  // if it carries the page's token, which they never see.
  it("ignores a message without the page's token", () => {
    const forged = { source: EXPORT_RENDER_SOURCE, type: 'page', index: 0, base64: 'QUJD' }
    expect(parseExportRenderMessage(JSON.stringify(forged), TOKEN)).toBeNull()
    expect(
      parseExportRenderMessage(JSON.stringify({ ...forged, token: 'guess' }), TOKEN)
    ).toBeNull()
    expect(
      parseExportRenderMessage(JSON.stringify({ ...forged, token: TOKEN }), 'other')
    ).toBeNull()
  })
  // Review 8, L11: an artifact's frame can post to the app straight, megabytes a message;
  // nothing without the page's own opening (its token) is parsed at all.
  it('parses nothing that does not open as a message of the page does', () => {
    const parse = jest.spyOn(JSON, 'parse')
    try {
      const flood = `{"source":"${EXPORT_RENDER_SOURCE}","token":"guess","pages":["${'A'.repeat(1_000_000)}"]}`
      expect(parseExportRenderMessage(flood, TOKEN)).toBeNull()
      expect(parseExportRenderMessage(`  ${msg({ type: 'svg', svg: '<svg/>' })}`, TOKEN)).toBeNull()
      expect(parse).not.toHaveBeenCalled()
      expect(parseExportRenderMessage(msg({ type: 'svg', svg: '<svg/>' }), TOKEN)).toEqual({
        type: 'svg',
        svg: '<svg/>'
      })
    } finally {
      parse.mockRestore()
    }
  })

  // Review 9, L2: the token is the only guard (a frame inside the artifact posts as
  // about:blank too); a message longer than any the page sends is dropped unread, before
  // even its opening is compared.
  it('drops a message longer than the cap unread, whatever it opens with', () => {
    const ok = msg({ type: 'svg', svg: '<svg/>' })
    expect(parseExportRenderMessage(ok, TOKEN, ok.length)).toEqual({ type: 'svg', svg: '<svg/>' })
    const startsWith = jest.spyOn(String.prototype, 'startsWith')
    try {
      expect(parseExportRenderMessage(ok, TOKEN, ok.length - 1)).toBeNull()
      expect(startsWith).not.toHaveBeenCalled()
    } finally {
      startsWith.mockRestore()
    }
  })

  it('the caps sit well above the largest message each page sends', () => {
    // A page picture of an html artifact: 1078 × 1560 pixels at most, RGBA, base64.
    const page = Math.ceil((1078 * 1560 * 4) / 3) * 4
    expect(HTML_MESSAGE_MAX_CHARS).toBeGreaterThanOrEqual(2 * page)
    expect(HTML_MESSAGE_MAX_CHARS).toBeLessThan(64 * 1024 * 1024)
    expect(htmlRasterPage('x', 't', 'void 0').maxMessageChars).toBe(HTML_MESSAGE_MAX_CHARS)
    // A PNG of an SVG: up to 16M pixels.
    const png = Math.ceil((16_000_000 * 4) / 3) * 4
    expect(EXPORT_MESSAGE_MAX_CHARS).toBeGreaterThanOrEqual(2 * png)
  })
})

describe("collectExportReply: an html render's pages, put together", () => {
  const page = (index: number, base64 = 'QUJD') => ({ type: 'page' as const, index, base64 })

  it('collects the pages in order and answers at their end', () => {
    const take = collectExportReply()
    expect(take({ type: 'progress' })).toBeNull()
    expect(take(page(0, 'QUJD'))).toBeNull()
    expect(take(page(1, 'REVG'))).toBeNull()
    expect(take({ type: 'pages-end', count: 2, textLabels: false })).toEqual({
      type: 'pages',
      pages: ['QUJD', 'REVG'],
      textLabels: false
    })
  })

  it('a restart drops the pages so far (drawn again with text labels)', () => {
    const take = collectExportReply()
    take(page(0, 'T0xE'))
    expect(take({ type: 'restart' })).toBeNull()
    take(page(0, 'TkVX'))
    expect(take({ type: 'pages-end', count: 1, textLabels: true })).toEqual({
      type: 'pages',
      pages: ['TkVX'],
      textLabels: true
    })
  })

  it('a page out of order, a missing page or no page at all is an error', () => {
    let take = collectExportReply()
    expect(take(page(1))).toMatchObject({ type: 'error', code: 'render' })
    take = collectExportReply()
    take(page(0))
    expect(take({ type: 'pages-end', count: 2, textLabels: false })).toMatchObject({
      type: 'error',
      code: 'render'
    })
    take = collectExportReply()
    expect(take({ type: 'pages-end', count: 0, textLabels: false })).toMatchObject({
      type: 'error',
      code: 'render'
    })
  })

  it('a reply of another page passes straight through', () => {
    const take = collectExportReply()
    expect(take({ type: 'svg', svg: '<svg/>' })).toEqual({ type: 'svg', svg: '<svg/>' })
    expect(take({ type: 'error', code: 'tainted', message: 'x' })).toEqual({
      type: 'error',
      code: 'tainted',
      message: 'x'
    })
  })
})

describe('mermaidSvgPage: draws the diagram and posts it back as static SVG', () => {
  const fakeMermaid = 'globalThis.mermaid = globalThis.__fakeMermaid'

  function fakeSvg() {
    const attrs: Record<string, string> = { width: '100%' }
    return {
      attrs,
      style: { maxWidth: '512px', height: '' } as Record<string, string>,
      viewBox: { baseVal: { width: 300, height: 120 } },
      setAttribute: (k: string, v: string) => {
        attrs[k] = String(v)
      },
      removeAttribute: (k: string) => {
        delete attrs[k]
      },
      get outerHTML() {
        return `<svg ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ')}></svg>`
      }
    }
  }

  function page(render: (id: string, source: string) => Promise<{ svg: string }>) {
    const svg = fakeSvg()
    const initialize = jest.fn()
    const host = { innerHTML: '', querySelector: () => svg }
    const globals = {
      __fakeMermaid: { initialize, render: jest.fn(render) },
      document: { getElementById: (id: string) => (id === 'export-host' ? host : null) }
    }
    return { svg, initialize, host, globals, mermaid: globals.__fakeMermaid }
  }

  it('renders the source with the export options, sizes the SVG to its viewBox', async () => {
    const p = page(async () => ({ svg: '<svg>drawn</svg>' }))
    const built = mermaidSvgPage('graph TD; A-->B </script>', fakeMermaid, { htmlLabels: true })
    const html = built.html
    const nonce = policyNonce(html)
    expect(scriptsOf(html)).toHaveLength(2)
    expect(html.match(/<script nonce="/g)).toHaveLength(2)
    expect(html).toContain(`nonce="${nonce}"`)
    // The source travels as a script string, never as markup.
    expect(html).not.toContain('</script>"')

    const reply = await runPage(built, p.globals)
    expect(p.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'default', layout: 'dagre', securityLevel: 'strict' })
    )
    expect(p.initialize.mock.calls[0][0]).toHaveProperty('htmlLabels', true)
    expect(p.mermaid.render).toHaveBeenCalledWith(expect.any(String), 'graph TD; A-->B </script>')
    expect(p.host.innerHTML).toBe('<svg>drawn</svg>')
    expect(reply).toEqual({
      type: 'svg',
      svg: expect.stringContaining('width="300" height="120"')
    })
    expect(p.svg.style.maxWidth).toBe('100%')
    expect(p.svg.style.height).toBe('auto')
  })

  it('labels as plain SVG text when asked (no foreignObject)', async () => {
    const p = page(async () => ({ svg: '<svg/>' }))
    await runPage(mermaidSvgPage('graph TD; A', fakeMermaid, { htmlLabels: false }), p.globals)
    expect(p.initialize).toHaveBeenCalledWith(expect.objectContaining({ htmlLabels: false }))
  })

  it("posts mermaid's error when the source doesn't parse", async () => {
    const p = page(async () => {
      throw new Error('Parse error on line 1')
    })
    const reply = await runPage(
      mermaidSvgPage('nope', fakeMermaid, { htmlLabels: true }),
      p.globals
    )
    expect(reply).toEqual({ type: 'error', code: 'render', message: 'Parse error on line 1' })
  })
})

describe('pngCapturePage: rasterises the SVG at 2x and posts the PNG back', () => {
  function capture(options: {
    svgAttrs: Record<string, string>
    viewBox?: { width: number; height: number } | null
    rect?: { width: number; height: number }
    imageFails?: boolean
    toDataURL?: () => string
  }) {
    const drawn: unknown[] = []
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        scale: (...a: unknown[]) => drawn.push(['scale', ...a]),
        fillRect: (...a: unknown[]) => drawn.push(['fillRect', ...a]),
        drawImage: (...a: unknown[]) => drawn.push(['drawImage', ...a.slice(1)]),
        set fillStyle(v: string) {
          drawn.push(['fillStyle', v])
        }
      }),
      toDataURL: jest.fn(options.toDataURL ?? (() => 'data:image/png;base64,UE5H'))
    }
    const clone = { setAttribute: jest.fn(), style: {} as Record<string, string> }
    const svg = {
      getAttribute: (k: string) => options.svgAttrs[k] ?? null,
      viewBox: { baseVal: options.viewBox ?? null },
      getBoundingClientRect: () => options.rect ?? { width: 0, height: 0 },
      cloneNode: () => clone
    }
    let loaded = ''
    class FakeImage {
      onload?: () => void
      onerror?: () => void
      set src(v: string) {
        loaded = v
        setTimeout(() => (options.imageFails ? this.onerror?.() : this.onload?.()), 0)
      }
    }
    const globals = {
      document: {
        querySelector: (s: string) => (s === 'svg' ? svg : null),
        createElement: (t: string) => (t === 'canvas' ? canvas : null)
      },
      XMLSerializer: class {
        serializeToString() {
          return '<svg xmlns="http://www.w3.org/2000/svg">x</svg>'
        }
      },
      Image: FakeImage
    }
    return { globals, canvas, clone, drawn, loaded: () => loaded }
  }

  it('uses the SVG’s own size, draws it on white at 2x', async () => {
    const c = capture({ svgAttrs: { width: '200', height: '100px' } })
    const page = pngCapturePage('<svg width="200" height="100px"></svg>', 'logo.svg')
    const html = page.html
    expect(html).toContain('<svg width="200" height="100px"></svg>')
    expect(html).toContain(`script-src 'nonce-${policyNonce(html)}'`)
    const reply = await runPage(page, c.globals)
    expect(reply).toEqual({ type: 'png', base64: 'UE5H', width: 400, height: 200 })
    expect(c.clone.setAttribute).toHaveBeenCalledWith('width', '200')
    expect(c.clone.setAttribute).toHaveBeenCalledWith('height', '100')
    expect(c.loaded()).toBe(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg">x</svg>')}`
    )
    expect(c.canvas.width).toBe(400)
    expect(c.canvas.height).toBe(200)
    expect(c.drawn).toEqual([
      ['scale', 2, 2],
      ['fillStyle', 'white'],
      ['fillRect', 0, 0, 200, 100],
      ['drawImage', 0, 0, 200, 100]
    ])
  })

  it('falls back to the viewBox, then to the laid-out box', async () => {
    const byViewBox = capture({ svgAttrs: { width: '100%' }, viewBox: { width: 30, height: 15 } })
    expect(await runPage(pngCapturePage('<svg/>', 't'), byViewBox.globals)).toMatchObject({
      width: 60,
      height: 30
    })
    const byRect = capture({ svgAttrs: {}, rect: { width: 50.2, height: 20 } })
    expect(await runPage(pngCapturePage('<svg/>', 't'), byRect.globals)).toMatchObject({
      width: 102,
      height: 40
    })
  })

  it('scales down a drawing too big for one canvas', async () => {
    const c = capture({ svgAttrs: { width: '4000', height: '4000' } })
    const reply = await runPage(pngCapturePage('<svg/>', 't'), c.globals)
    expect(reply.type).toBe('png')
    expect(c.canvas.width * c.canvas.height).toBeLessThanOrEqual(16_000_000)
    expect(c.canvas.width).toBe(c.canvas.height)
  })

  it('says so when WebKit refuses to read the canvas back (an SVG with HTML in it)', async () => {
    const c = capture({
      svgAttrs: { width: '10', height: '10' },
      toDataURL: () => {
        throw new Error('SecurityError: The operation is insecure.')
      }
    })
    expect(await runPage(pngCapturePage('<svg/>', 't'), c.globals)).toEqual({
      type: 'error',
      code: 'tainted',
      message: 'SecurityError: The operation is insecure.'
    })
  })

  it("says so when the SVG can't be drawn", async () => {
    const c = capture({ svgAttrs: { width: '10', height: '10' }, imageFails: true })
    expect(await runPage(pngCapturePage('<svg/>', 't'), c.globals)).toMatchObject({
      type: 'error',
      code: 'render'
    })
    const empty = capture({ svgAttrs: { width: '10', height: '10' }, toDataURL: () => 'data:,' })
    expect(await runPage(pngCapturePage('<svg/>', 't'), empty.globals)).toMatchObject({
      type: 'error',
      code: 'render'
    })
  })

  it('posts an error for a page with no SVG', async () => {
    const c = capture({ svgAttrs: {} })
    c.globals.document.querySelector = () => null
    expect(await runPage(pngCapturePage('<p>no</p>', 't'), c.globals)).toMatchObject({
      type: 'error',
      code: 'render'
    })
  })
})

// Review 6, #4 / review 7, #1–#2: an html artifact runs in its own sandboxed frame
// (`htmlArtifactDocument`, the frame's document); the snapshot script there posts the DOM
// as drawn to the host page once it has settled. The host's part: html-raster-page.test.ts.
describe('htmlArtifactDocument: the snapshot script posts the settled DOM to the host', () => {
  /** A small DOM: enough of WebKit's for the snapshot script. */
  class FakeNodeList {
    [index: number]: FakeElement
    private readonly items: FakeElement[]
    constructor(items: FakeElement[]) {
      this.items = items
      items.forEach((item, i) => {
        this[i] = item
      })
    }
    get length() {
      return this.items.length
    }
  }
  class FakeElement {
    parent: FakeElement | null = null
    children: FakeElement[] = []
    text = ''
    tagName: string
    attrs: Record<string, string>
    constructor(tag: string, attrs: Record<string, string> = {}, children: FakeElement[] = []) {
      this.tagName = tag
      this.attrs = { ...attrs }
      for (const child of children) this.append(child)
    }
    append(child: FakeElement) {
      child.parent = this
      this.children.push(child)
      return child
    }
    cloneNode(deep: boolean): FakeElement {
      const copy = new FakeElement(this.tagName, this.attrs)
      copy.text = this.text
      if (deep) for (const child of this.children) copy.append(child.cloneNode(true))
      return copy
    }
    querySelectorAll(selector: string): FakeNodeList {
      const found: FakeElement[] = []
      const walk = (el: FakeElement) => {
        for (const child of el.children) {
          if (child.tagName === selector) found.push(child)
          walk(child)
        }
      }
      walk(this)
      return new FakeNodeList(found)
    }
    remove() {
      if (!this.parent) return
      this.parent.children.splice(this.parent.children.indexOf(this), 1)
      this.parent = null
    }
    replaceWith(other: FakeElement) {
      const parent = this.parent
      if (!parent) return
      parent.children[parent.children.indexOf(this)] = other
      other.parent = parent
      this.parent = null
    }
    setAttribute(name: string, value: string) {
      this.attrs[name] = String(value)
    }
    getAttribute(name: string) {
      return name in this.attrs ? this.attrs[name] : null
    }
    set textContent(value: string) {
      this.children = []
      this.text = value
    }
    get outerHTML(): string {
      const attrs = Object.entries(this.attrs)
        .map(([k, v]) => ` ${k}="${v}"`)
        .join('')
      const inner = this.text + this.children.map((c) => c.outerHTML).join('')
      return `<${this.tagName}${attrs}>${inner}</${this.tagName}>`
    }
  }
  class FakeCanvas extends FakeElement {
    constructor(
      attrs: Record<string, string>,
      private readonly drawn: () => string
    ) {
      super('canvas', attrs)
    }
    toDataURL() {
      return this.drawn()
    }
  }
  class FakeStyle extends FakeElement {
    sheet: { cssRules: { cssText: string }[] }
    constructor(text: string, rules: string[]) {
      super('style')
      this.text = text
      this.sheet = { cssRules: rules.map((cssText) => ({ cssText })) }
    }
  }
  class FakeDocument {
    root: FakeElement
    currentScript: FakeElement | null
    adoptedStyleSheets: unknown[] = []
    constructor(root: FakeElement, currentScript: FakeElement) {
      this.root = root
      this.currentScript = currentScript
    }
    get documentElement() {
      return this.root
    }
    createElement(tag: string) {
      return new FakeElement(tag)
    }
  }

  /** The frame's first script: ours. */
  function snapshotScriptOf(doc: string): string {
    const m = /<head><script>([\s\S]*?)<\/script>/.exec(doc)
    if (!m) throw new Error('no script first in the head')
    return m[1]
  }

  /** The artifact's DOM (as WebKit parsed the page), and the frame's script run in it. */
  function load(doc: string, build: (head: FakeElement, body: FakeElement) => void) {
    const self = new FakeElement('script')
    const head = new FakeElement('head', {}, [self])
    const body = new FakeElement('body')
    build(head, body)
    const root = new FakeElement('html', {}, [head, body])
    const document = new FakeDocument(root, self)
    const posted: { message: unknown; target: string }[] = []
    const listeners: Record<string, (() => void)[]> = {}
    let onMutation: () => void = () => undefined
    const context: Record<string, unknown> = {
      document,
      window: {
        parent: {
          postMessage: (message: unknown, target: string) => posted.push({ message, target })
        },
        addEventListener: (type: string, fn: () => void) => {
          ;(listeners[type] ??= []).push(fn)
        }
      },
      MutationObserver: class {
        constructor(fn: () => void) {
          onMutation = fn
        }
        observe() {}
        disconnect() {
          onMutation = () => undefined
        }
      },
      setTimeout,
      clearTimeout,
      Date
    }
    runInNewContext(snapshotScriptOf(doc), context)
    return {
      head,
      body,
      fire: (type: string) => {
        for (const fn of listeners[type] ?? []) fn()
      },
      mutate: () => onMutation(),
      posted
    }
  }

  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }))
  afterEach(() => jest.useRealTimers())

  it("is the shared html document, the artifact's scripts on, ours first in its head", () => {
    const doc = htmlArtifactDocument('<h1>Chart</h1><script>draw()</script>', 'r.html')
    // No policy: the artifact runs as it does in the viewer and on desktop.
    expect(doc).not.toContain('Content-Security-Policy')
    expect(doc).toContain('<h1>Chart</h1><script>draw()</script>')
    // Ours is the first thing in the head: it runs before any of the artifact's.
    expect(doc.indexOf('<head><script>')).toBe(doc.indexOf('<head>'))
    // The frame holds no token: it is the host's alone.
    expect(doc).not.toMatch(/token/i)
  })

  it('waits for load and a quiet DOM, then posts the DOM as drawn to the host', () => {
    const p = load(htmlArtifactDocument('<div id="chart"></div>', 'r.html'), (head, body) => {
      head.append(new FakeStyle('', ['.bar { color: red; }']))
      body.append(new FakeElement('div', { id: 'chart' }))
      body.append(new FakeElement('script', {}, []))
      body.append(
        new FakeCanvas(
          { width: '800', height: '400', style: 'width:400px' },
          () => 'data:image/png;base64,QkFS'
        )
      )
      body.append(
        new FakeCanvas({ id: 'webgl' }, () => {
          throw new Error('SecurityError')
        })
      )
    })
    // Our script took itself out of the page before anything else ran.
    expect(p.head.children.some((c) => c.tagName === 'script')).toBe(false)

    // Not loaded yet: nothing, however long it takes short of the cap.
    jest.advanceTimersByTime(HTML_SETTLE.maxLoadMs - 200)
    expect(p.posted).toEqual([])

    // Loaded (the host is told: its navigation guard); quiet, but a chart may still be
    // animating in: no snapshot yet.
    p.fire('load')
    expect(p.posted).toEqual([{ message: { type: 'slz-export-loaded' }, target: '*' }])
    p.posted.length = 0
    jest.advanceTimersByTime(HTML_SETTLE.minAfterLoadMs - 200)
    expect(p.posted).toEqual([])
    // The artifact draws (mutations) for a while after: taken once quiet.
    p.mutate()
    p.body.append(new FakeElement('p', { id: 'late' }))
    jest.advanceTimersByTime(400)
    p.mutate()
    jest.advanceTimersByTime(HTML_SETTLE.quietMs - 200)
    expect(p.posted).toEqual([])
    jest.advanceTimersByTime(400)

    expect(p.posted).toHaveLength(1)
    const { message, target } = p.posted[0] as {
      message: { type: string; html: string }
      target: string
    }
    // To the host page (an opaque-origin frame can only say "*").
    expect(target).toBe('*')
    expect(message.type).toBe('slz-export-snapshot')
    // What the artifact drew, late content included; no script.
    expect(message.html).toContain('<div id="chart">')
    expect(message.html).toContain('<p id="late">')
    expect(message.html).not.toContain('<script')
    // A drawn canvas becomes its picture; one that can't be read stays a canvas.
    expect(message.html).toContain(
      '<img width="800" height="400" style="width:400px;max-width:100%;height:auto" src="data:image/png;base64,QkFS">'
    )
    expect(message.html).toContain('<canvas id="webgl">')
    // Style rules inserted by script (CSSOM) are kept.
    expect(message.html).toContain('<style>.bar { color: red; }\n</style>')
    // The page itself is untouched: the snapshot is a copy.
    expect(p.body.children.some((c) => c.tagName === 'script')).toBe(true)
  })

  // Review 7, #1: a CSSOM string can serialize as "</style>"; escaped, it stays CSS.
  it('escapes "<" in CSSOM text, so no "</style>" can form', () => {
    const p = load(htmlArtifactDocument('x', 't'), (head) => {
      head.append(new FakeStyle('', ['.x::before { content: "</style><iframe src=x>"; }']))
    })
    jest.advanceTimersByTime(HTML_SETTLE.maxLoadMs + 200)
    const { message } = p.posted[0] as { message: { html: string } }
    expect(message.html).toContain(
      '<style>.x::before { content: "\\3c /style>\\3c iframe src=x>"; }\n</style>'
    )
    expect(message.html).not.toContain('</style><iframe')
  })

  it('a page that never stops changing is taken anyway, after the cap', () => {
    const p = load(htmlArtifactDocument('x', 't'), () => undefined)
    p.fire('load')
    p.posted.length = 0
    for (let t = 0; t < HTML_SETTLE.maxAfterLoadMs - 200; t += 100) {
      p.mutate()
      jest.advanceTimersByTime(100)
    }
    expect(p.posted).toEqual([])
    p.mutate()
    jest.advanceTimersByTime(400)
    expect(p.posted).toMatchObject([{ message: { type: 'slz-export-snapshot' } }])
  })

  it('a page whose load never ends (a hung request) is taken anyway, after the cap', () => {
    const p = load(htmlArtifactDocument('x', 't'), () => undefined)
    jest.advanceTimersByTime(HTML_SETTLE.maxLoadMs + 200)
    expect(p.posted).toMatchObject([{ message: { type: 'slz-export-snapshot' } }])
  })
})

describe('htmlPrintDocument: the page pictures, and nothing else', () => {
  it('one picture per sheet, behind a policy that loads nothing else', () => {
    const doc = htmlPrintDocument(['QUJD', 'REVG'])
    expect(
      doc.startsWith('<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy"')
    ).toBe(true)
    expect(doc).toContain(`content="${HTML_PRINT_POLICY}"`)
    expect(HTML_PRINT_POLICY).toContain("default-src 'none'")
    expect(HTML_PRINT_POLICY).toContain('img-src data:')
    expect(HTML_PRINT_POLICY).not.toMatch(/https?:/)
    expect(doc).toContain(
      '<body><img alt="" src="data:image/png;base64,QUJD"><img alt="" src="data:image/png;base64,REVG"></body>'
    )
    expect(doc).toContain('img + img { break-before: page; }')
  })

  it('refuses anything that is not base64 (no markup can be written in)', () => {
    expect(() => htmlPrintDocument(['QUJD"><iframe src=x>'])).toThrow('not a PNG')
    expect(() => htmlPrintDocument([''])).toThrow('not a PNG')
    expect(() => htmlPrintDocument([])).toThrow('no pages')
  })
})
