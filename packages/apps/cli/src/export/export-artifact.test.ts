/**
 * `download --type pdf|png|html` once the content is in hand: which document is built,
 * whether a browser is needed, where it comes from (--browser → found → --install-browser)
 * and the exact refusal when there is none. Every engine is injected; no browser runs.
 */
import { describe, expect, test, vi } from 'vitest'
import { EXPORT_READY_EXPRESSION } from '@slayzone/task-artifacts/export-html'
import { type ExportDeps, ExportError, exportArtifact, noBrowserMessage } from './export-artifact'

const MERMAID_STUB = 'window.mermaid = {};'

function deps(over: Partial<ExportDeps> = {}): ExportDeps & {
  calls: { pdf: Array<[string, string, boolean]>; png: Array<[string, string, boolean]> }
} {
  const calls = {
    pdf: [] as Array<[string, string, boolean]>,
    png: [] as Array<[string, string, boolean]>
  }
  return {
    calls,
    loadMermaidJs: vi.fn(() => MERMAID_STUB),
    findBrowser: vi.fn(() => '/found/chrome'),
    isExecutable: vi.fn(() => true),
    installBrowser: vi.fn(async () => '/cache/headless-shell'),
    renderPdf: vi.fn(async (browser: string, html: string, o: { waitReady: boolean }) => {
      calls.pdf.push([browser, html, o.waitReady])
      return Buffer.from('%PDF-1.7')
    }),
    renderPng: vi.fn(async (browser: string, html: string, o: { waitReady: boolean }) => {
      calls.png.push([browser, html, o.waitReady])
      return Buffer.from([0x89, 0x50, 0x4e, 0x47])
    }),
    log: vi.fn(),
    ...over
  }
}

const md = { content: '# Hello\n\nworld', mode: 'markdown', title: 'notes.md' }
const svg = { content: '<svg width="10" height="10"></svg>', mode: 'svg-preview', title: 'a.svg' }
const mmd = { content: 'graph TD; A-->B', mode: 'mermaid-preview', title: 'flow.mmd' }

describe('html', () => {
  test('writes the shared document; no browser is looked for', async () => {
    const d = deps()
    const out = await exportArtifact({ ...md, type: 'html' }, d)
    expect(out.toString('utf8')).toContain('<h1>Hello</h1>')
    expect(out.toString('utf8')).toContain('<title>notes.md</title>')
    expect(d.findBrowser).not.toHaveBeenCalled()
    expect(d.loadMermaidJs).not.toHaveBeenCalled()
  })

  test('mermaid html embeds mermaid so the file draws when opened', async () => {
    const d = deps()
    const out = (await exportArtifact({ ...mmd, type: 'html' }, d)).toString('utf8')
    expect(out).toContain(MERMAID_STUB)
    expect(out).toContain('graph TD; A--&gt;B')
  })
})

describe('pdf / png', () => {
  test('pdf of markdown renders in the found browser, no ready wait, no mermaid load', async () => {
    const d = deps()
    const out = await exportArtifact({ ...md, type: 'pdf' }, d)
    expect(out.toString()).toBe('%PDF-1.7')
    expect(d.calls.pdf).toHaveLength(1)
    const [browser, html, waitReady] = d.calls.pdf[0]
    expect(browser).toBe('/found/chrome')
    expect(html).toContain('<h1>Hello</h1>')
    expect(waitReady).toBe(false)
    expect(d.loadMermaidJs).not.toHaveBeenCalled()
  })

  test('png of mermaid waits for the ready flag and carries mermaid', async () => {
    const d = deps()
    await exportArtifact({ ...mmd, type: 'png' }, d)
    const [, html, waitReady] = d.calls.png[0]
    expect(waitReady).toBe(true)
    expect(html).toContain(MERMAID_STUB)
    expect(html).toContain('exportReady')
    expect(EXPORT_READY_EXPRESSION).toContain('exportReady')
  })

  test('png of svg: the tight document, no wait', async () => {
    const d = deps()
    await exportArtifact({ ...svg, type: 'png' }, d)
    const [, html, waitReady] = d.calls.png[0]
    expect(html).toContain('display:inline-block')
    expect(waitReady).toBe(false)
  })

  test('--browser wins over discovery', async () => {
    const d = deps()
    await exportArtifact({ ...md, type: 'pdf', browser: '/my/chrome' }, d)
    expect(d.calls.pdf[0][0]).toBe('/my/chrome')
    expect(d.findBrowser).not.toHaveBeenCalled()
  })

  test('--browser that is not an executable is refused, not silently replaced', async () => {
    const d = deps({ isExecutable: vi.fn(() => false) })
    const err = await exportArtifact({ ...md, type: 'pdf', browser: '/nope' }, d).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(ExportError)
    expect((err as Error).message).toBe('Browser not found or not executable: /nope')
    expect(d.findBrowser).not.toHaveBeenCalled()
  })

  test('nothing found, no --install-browser → the exact refusal, nothing downloaded', async () => {
    const d = deps({ findBrowser: vi.fn(() => null) })
    const err = await exportArtifact({ ...md, type: 'pdf' }, d).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ExportError)
    expect((err as Error).message).toBe(
      'No browser found to render PDF.\n' +
        'Run again with --install-browser (downloads Chromium, ~100 MB, once),\n' +
        'or use --type html.'
    )
    expect(d.installBrowser).not.toHaveBeenCalled()
  })

  test('the PNG refusal names PNG', () => {
    expect(noBrowserMessage('png').split('\n')[0]).toBe('No browser found to render PNG.')
  })

  test('nothing found + --install-browser → installs, then renders with it', async () => {
    const d = deps({ findBrowser: vi.fn(() => null) })
    await exportArtifact({ ...svg, type: 'png', installBrowser: true }, d)
    expect(d.installBrowser).toHaveBeenCalledTimes(1)
    expect(d.calls.png[0][0]).toBe('/cache/headless-shell')
  })

  test('--install-browser with a browser already found downloads nothing', async () => {
    const d = deps()
    await exportArtifact({ ...md, type: 'pdf', installBrowser: true }, d)
    expect(d.installBrowser).not.toHaveBeenCalled()
    expect(d.calls.pdf[0][0]).toBe('/found/chrome')
  })

  test('a mode with no export of that type is refused', async () => {
    const err = await exportArtifact(
      { content: 'x', mode: 'markdown', title: 'n.md', type: 'png' },
      deps()
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ExportError)
  })
})
