/**
 * @jest-environment ./jest.jsdom-environment.js
 */
/**
 * Review 7, #1 and #2: an html artifact exported as PDF, end to end — `exportArtifact`
 * with the real pages, run in jsdom as the hidden web view would run them, and the
 * document handed to expo-print parsed for real (`JSDOM`, the HTML parser).
 *
 * #1: the artifact's scripts can write DOM whose serialization re-parses into live
 * elements (raw-text elements, style text, CSSOM strings, declarative shadow roots). None
 * of it may reach the printed document: it holds the page pictures and nothing the
 * artifact wrote — no frame, refresh, script, plugin, or artifact text.
 * #2: the artifact runs only inside a `sandbox="allow-scripts"` frame (no allow-modals:
 * alert/confirm/prompt never become native dialogs; a frame it creates inherits that).
 */
import { printToFileAsync } from 'expo-print'
import { type ExportArtifactDeps, exportArtifact } from './export-artifact'
import { JSDOM, webViewRender } from './testing-web-view'

jest.mock('expo-print', () => ({ printToFileAsync: jest.fn() }))
jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(async () => undefined) }))
jest.mock('expo-file-system', () => {
  const uriOf = (parts: unknown[]) =>
    parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/')
  class FakeDirectory {
    uri: string
    constructor(...parts: unknown[]) {
      this.uri = uriOf(parts)
    }
    exists = false
    create() {}
    list() {
      return []
    }
  }
  class FakeFile {
    uri: string
    constructor(...parts: unknown[]) {
      this.uri = uriOf(parts)
    }
    get name() {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1)
    }
    create() {}
    async write() {}
    delete() {}
    async move(to: { uri: string }) {
      this.uri = to.uri
    }
  }
  return { Directory: FakeDirectory, File: FakeFile, Paths: { cache: { uri: 'file:///cache' } } }
})

const print = jest.mocked(printToFileAsync)

/** Text only the artifact holds: it must never be in the printed document. */
const MARKER = 'ARTIFACT-MARKER-7f3a'

/** What a breakout would make live: a remote frame, a refresh, a script, plugins. */
const EVIL =
  '<iframe src="https://evil.example/frame"></iframe>' +
  '<meta http-equiv="refresh" content="0;url=https://evil.example/refresh">' +
  '<script>window.evil = 1</script>' +
  '<object data="https://evil.example/object"></object><embed src="https://evil.example/embed">'

/** An artifact whose own script writes `build` (a JS body) once it has loaded. */
const artifact = (build: string) =>
  `<h1>${MARKER}</h1><script>window.addEventListener('load', function () { ${build} });</script>`

/** A string as script source inside an inline `<script>` (no `</script>` in it). */
const js = (text: string) => JSON.stringify(text).replace(/</g, '\\u003c')

const raw = (tag: string) =>
  `var el = document.createElement('${tag}'); el.textContent = ${js(`</${tag}>${EVIL}`)}; document.body.appendChild(el);`

const SHAPES: [string, string][] = [
  ['xmp text', raw('xmp')],
  ['noembed text', raw('noembed')],
  ['noframes text', raw('noframes')],
  ['iframe text', raw('iframe')],
  ['plaintext text', raw('plaintext')],
  ['style text', raw('style')],
  [
    '<style type=x> text',
    `var el = document.createElement('style'); el.type = 'x'; el.textContent = ${js(`</style>${EVIL}`)}; document.head.appendChild(el);`
  ],
  [
    'a CSSOM string with an escaped </style>',
    `var el = document.createElement('style'); document.head.appendChild(el);
     el.sheet.insertRule('.x::before { content: "\\\\3C/style\\\\3E\\\\3Ciframe src=https://evil.example/cssom\\\\3E\\\\3C/iframe\\\\3E" }', 0);`
  ],
  [
    'a declarative shadow root (template shadowrootmode)',
    `var host = document.createElement('div'); var t = document.createElement('template');
     t.setAttribute('shadowrootmode', 'open'); t.innerHTML = ${js(EVIL)};
     host.appendChild(t); document.body.appendChild(host);`
  ]
]

/** A fake html2canvas: a blank canvas of the asked size (jsdom has no layout). */
const FAKE_HTML2CANVAS = `window.html2canvas = function (element, options) {
  var canvas = document.createElement('canvas');
  canvas.width = Math.round(options.width * options.scale);
  canvas.height = Math.round(options.height * options.scale);
  return Promise.resolve(canvas);
};`

function deps(): ExportArtifactDeps {
  return {
    render: webViewRender,
    mermaidScript: async () => 'globalThis.mermaid = {}',
    html2canvasScript: async () => FAKE_HTML2CANVAS
  } as ExportArtifactDeps
}

/** Every element of a document, template contents included. */
function elementsOf(root: { querySelectorAll: (s: string) => ArrayLike<Element> }): Element[] {
  const found: Element[] = []
  for (const el of Array.from(root.querySelectorAll('*'))) {
    found.push(el)
    if (el.localName === 'template') {
      found.push(...elementsOf((el as HTMLTemplateElement).content))
    }
  }
  return found
}

/** The printed document, parsed as WebKit parses it. */
async function printedFor(content: string): Promise<{ html: string; doc: Document }> {
  print.mockReset()
  print.mockResolvedValue({ uri: 'file:///cache/Print/x.pdf', numberOfPages: 1 })
  await exportArtifact({ content, mode: 'html-preview', title: 'r.html', format: 'pdf' }, deps())
  const html = print.mock.calls[0]?.[0]?.html
  if (typeof html !== 'string') throw new Error('nothing was printed')
  return { html, doc: new JSDOM(html).window.document }
}

function expectOnlyPictures(html: string, doc: Document) {
  const elements = elementsOf(doc)
  const tags = elements.map((el) => el.localName)
  // Nothing that can run, navigate or load a page.
  for (const tag of [
    'iframe',
    'frame',
    'script',
    'object',
    'embed',
    'template',
    'noscript',
    'link',
    'base'
  ]) {
    expect(tags).not.toContain(tag)
  }
  // Review 9, F2: no URL at all but the pictures' own data: ones.
  for (const el of elements) {
    for (const attr of Array.from(el.attributes)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(attr.value.trim()) && attr.name !== 'content') {
        expect(`${attr.name}=${attr.value}`).toMatch(/^src=data:image\/png;base64,/)
      }
    }
  }
  expect(html).not.toMatch(/(https?|file|blob|javascript):/i)
  const metas = elements.filter((el) => el.localName === 'meta')
  expect(metas.map((m) => m.getAttribute('http-equiv'))).toEqual(['Content-Security-Policy'])
  // Nothing of the artifact's: our page pictures only.
  expect(new Set(tags)).toEqual(new Set(['html', 'head', 'meta', 'style', 'body', 'img']))
  expect(html).not.toContain(MARKER)
  for (const img of elements.filter((el) => el.localName === 'img')) {
    expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/)
  }
  // The printer loads nothing but those pictures.
  const policy = metas[0].getAttribute('content') ?? ''
  expect(policy).toContain("default-src 'none'")
  expect(policy).toContain('img-src data:')
  expect(doc.head.firstElementChild).toBe(metas[0])
}

describe('an html artifact printed as PDF holds only its page pictures', () => {
  it.each(SHAPES)(
    '%s never becomes live markup in the printed document',
    async (_, build) => {
      const { html, doc } = await printedFor(artifact(build))
      expectOnlyPictures(html, doc)
    },
    20_000
  )

  it('an ordinary report prints as pictures too', async () => {
    const { html, doc } = await printedFor(
      `<h1>${MARKER}</h1><p>Report</p><canvas id="c"></canvas><script>document.title = 'x'</script>`
    )
    expectOnlyPictures(html, doc)
    expect(doc.querySelectorAll('img').length).toBeGreaterThan(0)
  }, 20_000)
})

describe('the artifact runs only inside a sandboxed frame (#2: no native dialogs)', () => {
  it('the page the web view loads is not the artifact: a sandbox="allow-scripts" frame holds it', async () => {
    const pages: string[] = []
    const d = deps()
    d.render = (page) => {
      pages.push(page.html)
      return webViewRender(page)
    }
    print.mockResolvedValue({ uri: 'file:///cache/Print/x.pdf', numberOfPages: 1 })
    await exportArtifact(
      { content: artifact("alert('hi')"), mode: 'html-preview', title: 'r.html', format: 'pdf' },
      d
    )
    expect(pages).toHaveLength(1)
    // The top-level page, parsed with scripts off: no artifact markup in it.
    const top = new JSDOM(pages[0]).window.document
    const frames = Array.from(top.querySelectorAll('iframe'))
    expect(frames).toHaveLength(1)
    // allow-scripts only: no allow-modals (dialogs), allow-same-origin, popups,
    // top navigation or forms. A frame the artifact makes inherits these flags.
    expect(frames[0].getAttribute('sandbox')?.trim().split(/\s+/)).toEqual(['allow-scripts'])
    expect(frames[0].getAttribute('srcdoc')).toContain(MARKER)
    frames[0].remove()
    expect(top.documentElement.outerHTML).not.toContain(MARKER)
  }, 20_000)
})

/**
 * Review 9, F2 (d): a markdown, code, svg or mermaid PDF is printed by expo-print from the
 * shared document (text stays text), and expo-print's web view has no navigation policy.
 * What its HTML parser sees is our policy and one script; the document arrives as data,
 * parsed inert and moved in without what navigates (print-document.test.ts: how).
 */
describe('a markdown, code, svg or mermaid PDF: nothing in it navigates the printer', () => {
  const REFRESH = '<meta http-equiv="refresh" content="0;url=https://evil.example/r">'
  const BASE = '<base href="https://evil.example/">'

  async function printed(
    content: string,
    mode: 'markdown' | 'code' | 'svg-preview' | 'mermaid-preview',
    drawn?: string
  ): Promise<string> {
    print.mockReset()
    print.mockResolvedValue({ uri: 'file:///cache/Print/x.pdf', numberOfPages: 1 })
    const d = deps()
    if (drawn) d.render = async () => ({ type: 'svg', svg: drawn })
    await exportArtifact({ content, mode, title: 'doc', format: 'pdf' }, d)
    const html = print.mock.calls[0]?.[0]?.html
    if (typeof html !== 'string') throw new Error('nothing was printed')
    return html
  }

  const SVG_VECTORS = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">${REFRESH}${BASE}</div></foreignObject><text>${MARKER}</text></svg>`

  it.each([
    ['markdown', `# ${MARKER}\n\n${REFRESH}\n\n${BASE}\n`, 'markdown' as const, undefined],
    ['code', `const a = '${REFRESH}' // ${MARKER}`, 'code' as const, undefined],
    ['svg', SVG_VECTORS, 'svg-preview' as const, undefined],
    ['mermaid', 'graph TD; A-->B', 'mermaid-preview' as const, SVG_VECTORS]
  ])(
    '%s: the printer parses none of it, and once run no refresh or base is live',
    async (_, content, mode, drawn) => {
      const html = await printed(content, mode, drawn)
      // As the printer's HTML parser sees it: our policy and our script.
      const parsedFirst: Document = new JSDOM(html).window.document
      expect(elementsOf(parsedFirst).map((el) => el.localName)).toEqual([
        'html',
        'head',
        'meta',
        'meta',
        'body',
        'script'
      ])
      // Run as the printer runs it: the document shows, nothing in it navigates.
      const run: Document = new JSDOM(html, { runScripts: 'dangerously' }).window.document
      const live = elementsOf(run)
      expect(live.filter((el) => el.localName === 'base')).toEqual([])
      expect(
        live.filter(
          (el) => el.localName === 'meta' && /refresh/i.test(el.getAttribute('http-equiv') ?? '')
        )
      ).toEqual([])
      expect(run.body.textContent).toContain(MARKER)
    }
  )
})
