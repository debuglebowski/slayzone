// @vitest-environment jsdom
/**
 * Review 9, F2: an exported document must not be able to navigate itself. A content
 * policy governs fetches, not navigation, so a `<meta http-equiv=refresh>` (or a
 * `<base>` re-pointing every relative link) in a markdown or svg body would take the
 * render — and the PDF — to a page the artifact chose, on every client. Parsed here
 * by a real HTML parser (jsdom's DOMParser), as a renderer would.
 */
import { describe, expect, it } from 'vitest'
import { buildDocumentHtml, buildDrawnMermaidDocumentHtml, buildPngHtml } from './export-html'

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')

/** Every meta/base element in the document except our own head (charset, policy). */
function hostile(doc: Document): string[] {
  return [...doc.querySelectorAll('meta, base')]
    .filter((el) => !(el.hasAttribute('charset') && el.parentElement === doc.head))
    .filter(
      (el) =>
        !(
          el.getAttribute('http-equiv') === 'Content-Security-Policy' &&
          el.parentElement === doc.head &&
          el === doc.head.querySelector('meta[http-equiv="Content-Security-Policy"]')
        )
    )
    .map((el) => el.outerHTML)
}

const SHAPES = [
  '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
  '<META HTTP-EQUIV=Refresh CONTENT="0;URL=https://evil.example/">',
  '<meta\nhttp-equiv=refresh\ncontent=0>',
  '<meta/http-equiv=refresh/content=0>',
  '<base href="https://evil.example/">',
  '<BASE\thref=https://evil.example/>'
]

describe('no exported document can navigate itself', () => {
  for (const shape of SHAPES) {
    it(`markdown body: ${JSON.stringify(shape)} is inert`, () => {
      for (const content of [
        shape,
        `# Title\n\ntext ${shape} more\n`,
        `<div>\n${shape}\n</div>\n`
      ]) {
        const doc = parse(buildDocumentHtml(content, 'markdown', 't.md'))
        expect(hostile(doc), content).toEqual([])
      }
    })

    it(`svg body (incl. breaking out of foreign content): ${JSON.stringify(shape)} is inert`, () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">${shape}<text>x</text></svg>`
      expect(hostile(parse(buildDocumentHtml(svg, 'svg-preview', 't.svg')))).toEqual([])
      expect(hostile(parse(buildPngHtml(svg, 'svg-preview', 't.svg') as string))).toEqual([])
      expect(hostile(parse(buildDrawnMermaidDocumentHtml(svg, 'd.mmd')))).toEqual([])
    })
  }

  it('the text a person wrote about these tags still shows', () => {
    const doc = parse(
      buildDocumentHtml('Use `<meta>` and <meta http-equiv=refresh>.', 'markdown', 't')
    )
    expect(doc.body.textContent).toContain('<meta>')
    expect(hostile(doc)).toEqual([])
  })

  it('code is untouched (it was escaped already)', () => {
    const html = buildDocumentHtml('<meta http-equiv=refresh>', 'code', 'x.html')
    expect(parse(html).body.textContent).toContain('<meta http-equiv=refresh>')
  })

  it('an html artifact is rendered as written (each host blocks its navigation)', () => {
    const shape = '<meta http-equiv="refresh" content="0">'
    expect(buildDocumentHtml(shape, 'html-preview', 't')).toContain(shape)
  })
})
