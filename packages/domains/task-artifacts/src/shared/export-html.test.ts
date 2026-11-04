import { describe, expect, it } from 'vitest'
import {
  buildDocumentHtml,
  buildDrawnMermaidDocumentHtml,
  buildPngHtml,
  exportBaseName,
  needsMermaidScript,
  needsReadyWait
} from './export-html'

const MERMAID_JS = 'window.mermaid = { initialize() {}, run() { return Promise.resolve() } }'

describe('buildDocumentHtml', () => {
  it('renders markdown to HTML with the title escaped', () => {
    const html = buildDocumentHtml('# Hello\n\n- item', 'markdown', 'a <b> & c')
    expect(html).toContain('<h1>Hello</h1>')
    expect(html).toContain('<li>item</li>')
    expect(html).toContain('<title>a &lt;b&gt; &amp; c</title>')
  })

  it('numbers code lines and escapes them', () => {
    const html = buildDocumentHtml('let a = 1 < 2\nb', 'code', 'x.ts')
    expect(html).toContain('<td class="line-numbers">1</td><td>let a = 1 &lt; 2</td>')
    expect(html).toContain('<td class="line-numbers">2</td><td>b</td>')
  })

  it('embeds html and svg as-is', () => {
    expect(buildDocumentHtml('<p id="raw">x</p>', 'html-preview', 't')).toContain(
      '<body><p id="raw">x</p></body>'
    )
    expect(buildDocumentHtml('<svg></svg>', 'svg-preview', 't')).toContain('<svg></svg>')
  })

  it('draws mermaid in the document and flags ready', () => {
    const html = buildDocumentHtml('graph TD; A-->B', 'mermaid-preview', 'd.mmd', MERMAID_JS)
    expect(html).toContain('<pre class="mermaid">graph TD; A--&gt;B</pre>')
    expect(html).toContain(MERMAID_JS)
    expect(html).toContain("document.documentElement.dataset.exportReady = '1'")
    // The title stays the artifact's, not a readiness marker.
    expect(html).toContain('<title>d.mmd</title>')
  })

  it('degrades mermaid to code without the mermaid build', () => {
    const html = buildDocumentHtml('graph TD', 'mermaid-preview', 'd.mmd', null)
    expect(html).toContain('class="code-table"')
    expect(html).not.toContain('class="mermaid"')
  })

  it('keeps a </script inside the mermaid build from closing the tag', () => {
    const html = buildDocumentHtml('graph TD', 'mermaid-preview', 'd', 'var s = "</script>"')
    expect(html).toContain('var s = "<\\/script>"')
  })
})

describe('buildDrawnMermaidDocumentHtml', () => {
  it('lays out a drawn diagram like the scripted document, without a script', () => {
    const html = buildDrawnMermaidDocumentHtml('<svg id="d"></svg>', 'd.mmd')
    expect(html).toContain('<pre class="mermaid"><svg id="d"></svg></pre>')
    expect(html).toContain('.mermaid svg { max-width: 100%; }')
    expect(html).not.toContain('<script')
  })
})

describe('buildPngHtml', () => {
  it('wraps svg as the first body element', () => {
    const html = buildPngHtml('<svg width="5"></svg>', 'svg-preview', 's.svg')
    expect(html).toContain('<body><div style="display:inline-block"><svg width="5"></svg></div>')
  })

  it('draws mermaid', () => {
    expect(buildPngHtml('graph TD', 'mermaid-preview', 'd', MERMAID_JS)).toContain(
      '<body><pre class="mermaid">graph TD</pre>'
    )
  })

  it('is null for modes without a PNG form, or mermaid without its build', () => {
    expect(buildPngHtml('# x', 'markdown', 'x.md')).toBeNull()
    expect(buildPngHtml('graph TD', 'mermaid-preview', 'd', null)).toBeNull()
  })
})

describe('helpers', () => {
  it('only mermaid waits and needs the script', () => {
    expect(needsReadyWait('mermaid-preview')).toBe(true)
    expect(needsMermaidScript('mermaid-preview')).toBe(true)
    for (const m of ['markdown', 'code', 'svg-preview', 'html-preview']) {
      expect(needsReadyWait(m)).toBe(false)
      expect(needsMermaidScript(m)).toBe(false)
    }
  })

  it('strips the extension for the file name', () => {
    expect(exportBaseName('notes.md')).toBe('notes')
    expect(exportBaseName('a.b.svg')).toBe('a.b')
    expect(exportBaseName('.hidden')).toBe('.hidden')
    expect(exportBaseName('plain')).toBe('plain')
  })
})
