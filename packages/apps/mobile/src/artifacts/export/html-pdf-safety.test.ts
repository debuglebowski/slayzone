/**
 * @jest-environment ./jest.jsdom-environment.js
 */
/**
 * Review 7, #1 and #2: an html artifact exported as PDF, end to end — `exportArtifact`
 * with the real pages, run in jsdom as the hidden web view would run them, and the PDF
 * written from their pictures read back (follow-up N3: written page by page, no
 * document printed).
 *
 * #1: the artifact's scripts can write DOM whose serialization re-parses into live
 * elements (raw-text elements, style text, CSSOM strings, declarative shadow roots). None
 * of it may reach the PDF: it holds the page pictures and nothing the artifact wrote —
 * no text, link, action, script, or URL.
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
    delete() {
      mockWritten.delete(this.uri)
    }
    async move(to: { uri: string }) {
      this.uri = to.uri
    }
    open() {
      const chunks: Uint8Array[] = []
      mockWritten.set(this.uri, chunks)
      return { writeBytesSync: (b: Uint8Array) => chunks.push(b.slice()), close() {} }
    }
  }
  return {
    Directory: FakeDirectory,
    File: FakeFile,
    FileMode: { Truncate: 'wt' },
    Paths: { cache: { uri: 'file:///cache' } }
  }
})

const print = jest.mocked(printToFileAsync)
/** What was written through each file's handle (the html artifact's PDF). */
const mockWritten = new Map<string, Uint8Array[]>()

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

/** The PDF written for an html artifact, as text (its structure is ASCII). */
async function pdfFor(content: string): Promise<string> {
  print.mockReset()
  mockWritten.clear()
  const uri = await exportArtifact(
    { content, mode: 'html-preview', title: 'r.html', format: 'pdf' },
    deps()
  )
  // Nothing printed: the pictures are written into the PDF themselves.
  expect(print).not.toHaveBeenCalled()
  const chunks = mockWritten.get(uri)
  if (!chunks) throw new Error('no PDF was written')
  return chunks.map((b) => Buffer.from(b).toString('latin1')).join('')
}

/** The PDF holds page pictures and nothing else. */
function expectOnlyPictures(pdf: string) {
  expect(pdf.startsWith('%PDF-1.4')).toBe(true)
  // Every object: the catalog, the page tree, pages, their pictures and the contents
  // that place them. Nothing that runs, links, opens or annotates.
  const kinds = new Set(
    [...pdf.matchAll(/\d+ 0 obj\n<< (\/Type \/\w+(?: \/Subtype \/\w+)?|\/Length \d+)/g)].map((m) =>
      m[1].startsWith('/Length') ? 'contents' : m[1]
    )
  )
  expect(kinds).toEqual(
    new Set([
      '/Type /Catalog',
      '/Type /Pages',
      '/Type /Page',
      '/Type /XObject /Subtype /Image',
      'contents'
    ])
  )
  for (const contents of pdf.matchAll(/<< \/Length \d+ >>\nstream\n([^\n]*)\nendstream/g)) {
    expect(contents[1]).toMatch(/^q [\d.]+ 0 0 [\d.]+ [\d.]+ [\d.]+ cm \/Im0 Do Q$/)
  }
  for (const key of [
    '/JavaScript',
    '/JS',
    '/URI',
    '/Launch',
    '/OpenAction',
    '/AA',
    '/Annots',
    '/Font'
  ]) {
    expect(pdf).not.toContain(key)
  }
  expect(pdf).not.toMatch(/(https?|file|blob|javascript):/i)
  expect(pdf).not.toContain(MARKER)
}

describe('an html artifact printed as PDF holds only its page pictures', () => {
  it.each(SHAPES)(
    '%s never becomes live markup in the printed document',
    async (_, build) => {
      expectOnlyPictures(await pdfFor(artifact(build)))
    },
    20_000
  )

  it('an ordinary report prints as pictures too', async () => {
    const pdf = await pdfFor(
      `<h1>${MARKER}</h1><p>Report</p><canvas id="c"></canvas><script>document.title = 'x'</script>`
    )
    expectOnlyPictures(pdf)
    expect(pdf).toMatch(/\/Count [1-9]/)
  }, 20_000)
})

describe('the artifact runs only inside a sandboxed frame (#2: no native dialogs)', () => {
  it('the page the web view loads is not the artifact: a sandbox="allow-scripts" frame holds it', async () => {
    const pages: string[] = []
    const d = deps()
    d.render = (page, sink) => {
      pages.push(page.html)
      return webViewRender(page, sink)
    }
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
