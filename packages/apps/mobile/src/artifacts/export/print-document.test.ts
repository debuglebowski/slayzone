/**
 * @jest-environment ./jest.jsdom-environment.js
 */
/**
 * Review 9, F2 (d): expo-print's WKWebView has no navigation policy (expo-print 58,
 * `ExpoWKPDFRenderer.swift`: a plain `WKNavigationDelegate` that prints on `didFinish`).
 * A `<meta http-equiv=refresh>` (or a `<base>`) its HTML parser sees in a markdown, code,
 * svg or mermaid document would navigate it, and the PDF would be another page. The
 * printer is handed `printDocument(document)` instead: its parser sees only our policy
 * and one script; the document is parsed inert (`DOMParser`), stripped of what navigates,
 * and moved in as nodes — never parsed live, never re-serialized.
 */
import { buildDocumentHtml, exportDocumentPolicy } from '@slayzone/task-artifacts/export-html'
import { printDocument } from './print-document'
import { JSDOM } from './testing-web-view'

const MARKER = 'DOC-MARKER-51c2'

/** A document as a hostile body could make it, the shared builder's guard aside. */
const HOSTILE = [
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
  `<meta http-equiv="Content-Security-Policy" content="${exportDocumentPolicy(null)}">`,
  '<title>t</title><style>h1 { color: red; }</style>',
  '<base href="https://evil.example/">',
  '</head><body class="doc">',
  `<h1>${MARKER}</h1>`,
  '<meta http-equiv="refresh" content="0;url=https://evil.example/r">',
  '<svg><foreignObject><meta http-equiv="refresh" content="0;url=https://evil.example/svg">',
  '<base href="https://evil.example/2/"></foreignObject></svg>',
  '<img src="pic.png" alt="pic">',
  '<iframe src="https://site.example/embed"></iframe>',
  '<script>window.ran = 1</script>',
  '<div id="host"><template shadowrootmode="open"><p>shadow</p>',
  '<meta http-equiv="refresh" content="0;url=https://evil.example/shadow"></template></div>',
  '<template id="kept"><meta http-equiv="refresh" content="0"><b>t</b></template>',
  '</body></html>'
].join('')

/** Every element, inside shadow roots and template contents too. */
function everyElement(root: ParentNode): Element[] {
  const found: Element[] = []
  for (const el of Array.from(root.querySelectorAll('*'))) {
    found.push(el)
    if (el.shadowRoot) found.push(...everyElement(el.shadowRoot))
    if (el.localName === 'template')
      found.push(...everyElement((el as HTMLTemplateElement).content))
  }
  return found
}

describe('printDocument: what expo-print parses holds nothing that can navigate', () => {
  it("the printer's HTML parser sees our policy and our script only", () => {
    const html = printDocument(HOSTILE)
    // Parsed as the printer's parser sees it, before any script runs.
    const doc = new JSDOM(html).window.document
    const tags = everyElement(doc).map((el) => el.localName)
    expect(tags).toEqual(['html', 'head', 'meta', 'meta', 'body', 'script'])
    const [charset, policy] = Array.from(doc.querySelectorAll('meta'))
    expect(charset.getAttribute('charset')).toBe('utf-8')
    const script = doc.querySelector('script') as HTMLScriptElement
    const nonce = script.getAttribute('nonce') ?? ''
    expect(nonce).toMatch(/^[0-9a-z]{16,}$/)
    // The shared documents' own policy, its one script allowed by nonce.
    expect(policy.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(policy.getAttribute('content')).toBe(exportDocumentPolicy(nonce))
    expect(html).not.toMatch(/<(meta|base|h1|iframe|img|template)\b[^>]*(refresh|evil|MARKER)/i)
    expect(printDocument(HOSTILE)).not.toContain(nonce)
  })

  it('run, it shows the document — without a refresh, a base, or a script of its own', () => {
    const dom = new JSDOM(printDocument(HOSTILE), { runScripts: 'dangerously' })
    const { document } = dom.window
    const all = everyElement(document)
    expect(all.filter((el) => el.localName === 'base')).toEqual([])
    expect(
      all.filter((el) => el.localName === 'meta').map((m) => m.getAttribute('http-equiv'))
    ).toEqual([null, 'Content-Security-Policy'])
    expect(all.filter((el) => el.localName === 'script')).toEqual([])
    expect((dom.window as unknown as { ran?: number }).ran).toBeUndefined()
    // What the document shows is all there.
    expect(document.documentElement.getAttribute('lang')).toBe('en')
    expect(document.body.getAttribute('class')).toBe('doc')
    expect(document.querySelector('h1')?.textContent).toBe(MARKER)
    expect(document.title).toBe('t')
    expect(document.head.querySelector('style')?.textContent).toBe('h1 { color: red; }')
    expect(document.querySelector('img')?.getAttribute('src')).toBe('pic.png')
    expect(document.getElementsByTagName('foreignObject')).toHaveLength(1)
    // A frame can't navigate the printer either (the policy blocks its load anyway).
    expect(document.querySelector('iframe')?.getAttribute('sandbox')).toBe('')
    // A declarative shadow root is attached, as the live parser would have.
    const host = document.getElementById('host') as HTMLElement
    expect(host.shadowRoot?.innerHTML).toBe('<p>shadow</p>')
    expect(host.querySelector('template')).toBeNull()
    expect(
      (document.getElementById('kept') as HTMLTemplateElement).content.childNodes
    ).toHaveLength(1)
  })

  it('a shared document prints as it did: the same body, head and root', () => {
    const shared = buildDocumentHtml(
      '# Plan\n\nSome *text*, `code`, and a [link](https://example.com).\n\n| a | b |\n|---|---|\n| 1 | 2 |',
      'markdown',
      'plan.md'
    )
    const before = new JSDOM(shared).window.document
    const after = new JSDOM(printDocument(shared), { runScripts: 'dangerously' }).window.document
    expect(after.body.innerHTML).toBe(before.body.innerHTML)
    expect(after.title).toBe('plan.md')
    expect(after.head.querySelector('style')?.textContent).toBe(
      before.head.querySelector('style')?.textContent
    )
  })
})
