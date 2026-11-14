import {
  buildDocumentHtml,
  buildDrawnMermaidDocumentHtml
} from '@slayzone/task-artifacts/export-html'
import { printToFileAsync } from 'expo-print'
import { shareAsync } from 'expo-sharing'
import { EXPORT_DIR, type ExportArtifactDeps, exportArtifact } from './export-artifact'
import type { ExportRenderReply } from './render-pages'

jest.mock('expo-print', () => ({ printToFileAsync: jest.fn() }))
jest.mock('expo-sharing', () => ({ shareAsync: jest.fn() }))
jest.mock('expo-file-system', () => {
  const join = (parts: unknown[]) =>
    parts
      .map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri))
      .join('/')
      .replace(/\/+/g, '/')
      .replace('file:/', 'file:///')
  class FakeDirectory {
    uri: string
    constructor(...parts: unknown[]) {
      this.uri = join(parts)
    }
    get exists() {
      return mockFs.dirs.has(this.uri)
    }
    create() {
      mockFs.log.push(['mkdir', this.uri])
      mockFs.dirs.add(this.uri)
    }
    delete() {
      mockFs.log.push(['rmdir', this.uri])
      mockFs.dirs.delete(this.uri)
    }
    list() {
      const prefix = `${this.uri.replace(/\/$/, '')}/`
      const child = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')
      return [
        ...[...mockFs.dirs].filter(child).map((d) => new FakeDirectory(d)),
        ...[...mockFs.files.keys()].filter(child).map((f) => new FakeFile(f))
      ]
    }
  }
  class FakeFile {
    uri: string
    constructor(...parts: unknown[]) {
      this.uri = join(parts)
    }
    get name() {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1)
    }
    create() {
      mockFs.log.push(['create', this.uri])
    }
    async write(content: string, options?: { encoding?: string }) {
      mockFs.files.set(this.uri, { content, encoding: options?.encoding ?? 'utf8' })
    }
    delete() {
      mockFs.log.push(['rm', this.uri])
      mockFs.files.delete(this.uri)
    }
    async move(to: { uri: string }) {
      mockFs.log.push(['move', this.uri, to.uri])
      this.uri = to.uri
    }
  }
  return {
    Directory: FakeDirectory,
    File: FakeFile,
    Paths: { cache: { uri: 'file:///cache/' } }
  }
})

const mockFs = {
  dirs: new Set<string>(),
  files: new Map<string, { content: string; encoding: string }>(),
  log: [] as unknown[][]
}
const OUT = `file:///cache/${EXPORT_DIR}`
/** `<OUT>/<this export's own folder>/<name>`. */
const inExportDir = (name: string) =>
  new RegExp(`^${OUT.replace(/[/.]/g, '\\$&')}/[^/]+/${name.replace('.', '\\.')}$`)

const print = jest.mocked(printToFileAsync)
const share = jest.mocked(shareAsync)

/** A renderer that answers each page with the next reply, and the pages it got. */
function renderer(...replies: ExportRenderReply[]): ExportArtifactDeps & { pages: string[] } {
  const pages: string[] = []
  return {
    pages,
    render: jest.fn(async (html: string) => {
      pages.push(html)
      const reply = replies.shift()
      if (!reply) throw new Error('unexpected render')
      return reply
    }),
    mermaidScript: jest.fn(async () => 'globalThis.mermaid={/*bundle*/}')
  }
}

beforeEach(() => {
  mockFs.dirs.clear()
  mockFs.files.clear()
  mockFs.log.length = 0
  print.mockReset()
  print.mockResolvedValue({ uri: 'file:///cache/Print/0F.pdf', numberOfPages: 1 })
  share.mockReset()
  share.mockResolvedValue(undefined)
})

describe('exportArtifact: HTML', () => {
  it('writes the shared document to <title>.html and opens the share sheet', async () => {
    const deps = renderer()
    const uri = await exportArtifact(
      { content: '# Plan', mode: 'markdown', title: 'plan.md', format: 'html' },
      deps
    )
    expect(uri).toMatch(inExportDir('plan.html'))
    expect(mockFs.files.get(uri)).toEqual({
      // The file a person keeps: no policy, as main exported it (review 5, #4).
      content: buildDocumentHtml('# Plan', 'markdown', 'plan.md', null, { standalone: true }),
      encoding: 'utf8'
    })
    expect(share).toHaveBeenCalledWith(uri, {
      mimeType: 'text/html',
      UTI: 'public.html',
      dialogTitle: 'plan.html'
    })
    expect(deps.render).not.toHaveBeenCalled()
    expect(deps.mermaidScript).not.toHaveBeenCalled()
  })

  it('a mermaid file keeps drawing itself: the document carries the mermaid build', async () => {
    const deps = renderer()
    const uri = await exportArtifact(
      { content: 'graph TD; A-->B', mode: 'mermaid-preview', title: 'flow.mmd', format: 'html' },
      deps
    )
    expect(mockFs.files.get(uri)?.content).toContain('globalThis.mermaid={/*bundle*/}')
    expect(mockFs.files.get(uri)?.content).toContain(
      '<pre class="mermaid">graph TD; A--&gt;B</pre>'
    )
    expect(deps.render).not.toHaveBeenCalled()
  })

  // Review 4, M3: each export has a folder of its own. Earlier exports' folders are
  // swept, never one whose export is still running (a second viewer screen).
  it('sweeps earlier exports, never piling files up', async () => {
    mockFs.dirs.add(OUT)
    mockFs.dirs.add(`${OUT}/old-1`)
    const uri = await exportArtifact(
      { content: 'x', mode: 'code', title: 'a.ts', format: 'html' },
      renderer()
    )
    expect(mockFs.log).toContainEqual(['rmdir', `${OUT}/old-1`])
    expect(uri.startsWith(`${OUT}/`)).toBe(true)
    expect(uri.endsWith('/a.html')).toBe(true)
  })

  it('a second export started meanwhile does not wipe the first one', async () => {
    let release: () => void = () => undefined
    share.mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
    const first = exportArtifact(
      { content: 'one', mode: 'code', title: 'one.ts', format: 'html' },
      renderer()
    )
    await new Promise((r) => setTimeout(r, 0))
    const firstUri = share.mock.calls[0][0]
    const firstDir = firstUri.slice(0, firstUri.lastIndexOf('/'))
    await exportArtifact(
      { content: 'two', mode: 'code', title: 'two.ts', format: 'html' },
      renderer()
    )
    expect(mockFs.log).not.toContainEqual(['rmdir', firstDir])
    expect(mockFs.dirs.has(firstDir)).toBe(true)
    release()
    await first
  })

  // Review 4, M4: printing that never finishes (an image on an unreachable host) ends
  // with an error instead of "Exporting…" forever.
  it('a print that never finishes times out with an error', async () => {
    print.mockImplementationOnce(() => new Promise(() => undefined))
    await expect(
      exportArtifact(
        { content: '# x', mode: 'markdown', title: 'p.md', format: 'pdf' },
        { ...renderer(), printTimeoutMs: 50 }
      )
    ).rejects.toThrow(/took too long/)
    expect(share).not.toHaveBeenCalled()
  })
})

// Review 5, #14: expo-print's scratch PDFs (`<caches>/Print/`) never pile up.
describe("exportArtifact: expo-print's scratch files", () => {
  const PRINTS = 'file:///cache/Print'
  const md = { content: '# x', mode: 'markdown' as const, title: 'p.md', format: 'pdf' as const }

  it('a PDF that lands after its export gave up is removed when it lands', async () => {
    let land: (r: { uri: string; numberOfPages: number }) => void = () => undefined
    print.mockImplementationOnce(() => new Promise((r) => (land = r)))
    await expect(exportArtifact(md, { ...renderer(), printTimeoutMs: 20 })).rejects.toThrow(
      /took too long/
    )
    mockFs.files.set(`${PRINTS}/late.pdf`, { content: '%PDF', encoding: 'utf8' })
    land({ uri: `${PRINTS}/late.pdf`, numberOfPages: 1 })
    await new Promise((r) => setTimeout(r, 0))
    expect(mockFs.log).toContainEqual(['rm', `${PRINTS}/late.pdf`])
  })

  it('leftovers of an earlier run are swept when no print is running', async () => {
    mockFs.dirs.add(PRINTS)
    mockFs.files.set(`${PRINTS}/killed.pdf`, { content: '%PDF', encoding: 'utf8' })
    await exportArtifact(md, renderer())
    expect(mockFs.log).toContainEqual(['rm', `${PRINTS}/killed.pdf`])
  })

  it('a print still running is never swept from under it', async () => {
    let land: (r: { uri: string; numberOfPages: number }) => void = () => undefined
    print.mockImplementationOnce(() => new Promise((r) => (land = r)))
    const first = exportArtifact(md, renderer())
    await new Promise((r) => setTimeout(r, 0))
    // The running print's file, as expo-print writes it.
    mockFs.dirs.add(PRINTS)
    mockFs.files.set(`${PRINTS}/running.pdf`, { content: '%PDF', encoding: 'utf8' })
    await exportArtifact(md, renderer())
    expect(mockFs.log).not.toContainEqual(['rm', `${PRINTS}/running.pdf`])
    land({ uri: `${PRINTS}/running.pdf`, numberOfPages: 1 })
    await first
    expect(mockFs.log).toContainEqual(['move', `${PRINTS}/running.pdf`, expect.anything()])
  })
})

describe('exportArtifact: PDF', () => {
  it("prints the shared document on A4 with desktop's margins, as <title>.pdf", async () => {
    const deps = renderer()
    const uri = await exportArtifact(
      { content: '# Plan', mode: 'markdown', title: 'plan.md', format: 'pdf' },
      deps
    )
    expect(print).toHaveBeenCalledWith({
      html: buildDocumentHtml('# Plan', 'markdown', 'plan.md'),
      width: 595,
      height: 842,
      margins: { left: 28, right: 28, top: 28, bottom: 28 }
    })
    expect(uri).toMatch(inExportDir('plan.pdf'))
    expect(mockFs.log).toContainEqual(['move', 'file:///cache/Print/0F.pdf', uri])
    expect(share).toHaveBeenCalledWith(uri, {
      mimeType: 'application/pdf',
      UTI: 'com.adobe.pdf',
      dialogTitle: 'plan.pdf'
    })
    expect(deps.render).not.toHaveBeenCalled()
  })

  it('draws a mermaid diagram first, then prints it as a static SVG document', async () => {
    const deps = renderer({ type: 'svg', svg: '<svg id="drawn"></svg>' })
    await exportArtifact(
      { content: 'graph TD; A-->B', mode: 'mermaid-preview', title: 'flow.mmd', format: 'pdf' },
      deps
    )
    expect(deps.pages).toHaveLength(1)
    expect(deps.pages[0]).toContain('globalThis.mermaid={/*bundle*/}')
    expect(deps.pages[0]).toContain('"graph TD; A--\\u003eB"')
    const html = print.mock.calls[0][0]?.html
    // Laid out like desktop's mermaid PDF, with the diagram already drawn.
    expect(html).toBe(buildDrawnMermaidDocumentHtml('<svg id="drawn"></svg>', 'flow.mmd'))
    // Nothing left to run in the printer's web view.
    expect(html).not.toContain('<script')
  })

  it("fails with mermaid's error when the diagram doesn't parse", async () => {
    const deps = renderer({ type: 'error', code: 'render', message: 'Parse error on line 1' })
    await expect(
      exportArtifact(
        { content: 'nope', mode: 'mermaid-preview', title: 'flow.mmd', format: 'pdf' },
        deps
      )
    ).rejects.toThrow("Couldn't draw the diagram: Parse error on line 1")
    expect(print).not.toHaveBeenCalled()
    expect(share).not.toHaveBeenCalled()
  })
})

describe('exportArtifact: PNG', () => {
  it('rasterises an SVG in the web view, writes the PNG bytes, shares them', async () => {
    const deps = renderer({ type: 'png', base64: 'UE5H', width: 40, height: 20 })
    const uri = await exportArtifact(
      {
        content: '<svg width="20" height="10"/>',
        mode: 'svg-preview',
        title: 'logo.svg',
        format: 'png'
      },
      deps
    )
    expect(deps.pages[0]).toContain('<svg width="20" height="10"/>')
    expect(uri).toMatch(inExportDir('logo.png'))
    expect(mockFs.files.get(uri)).toEqual({ content: 'UE5H', encoding: 'base64' })
    expect(share).toHaveBeenCalledWith(uri, {
      mimeType: 'image/png',
      UTI: 'public.png',
      dialogTitle: 'logo.png'
    })
  })

  it('a mermaid diagram: drawn to SVG, then rasterised', async () => {
    const deps = renderer(
      { type: 'svg', svg: '<svg id="drawn"></svg>' },
      { type: 'png', base64: 'UE5H', width: 40, height: 20 }
    )
    await exportArtifact(
      { content: 'graph TD; A', mode: 'mermaid-preview', title: 'flow.mmd', format: 'png' },
      deps
    )
    expect(deps.pages).toHaveLength(2)
    expect(deps.pages[1]).toContain('<svg id="drawn"></svg>')
  })

  it('WebKit refused the HTML labels: draws again with SVG text labels', async () => {
    const deps = renderer(
      { type: 'svg', svg: '<svg id="html-labels"></svg>' },
      { type: 'error', code: 'tainted', message: 'SecurityError' },
      { type: 'svg', svg: '<svg id="text-labels"></svg>' },
      { type: 'png', base64: 'UE5H', width: 40, height: 20 }
    )
    const uri = await exportArtifact(
      { content: 'graph TD; A', mode: 'mermaid-preview', title: 'flow.mmd', format: 'png' },
      deps
    )
    expect(deps.pages[0]).toContain('"htmlLabels":true')
    expect(deps.pages[2]).toContain('"htmlLabels":false')
    expect(deps.pages[3]).toContain('<svg id="text-labels"></svg>')
    expect(mockFs.files.get(uri)?.content).toBe('UE5H')
  })

  it('an SVG with HTML inside that WebKit refuses: says why', async () => {
    const deps = renderer({ type: 'error', code: 'tainted', message: 'SecurityError' })
    await expect(
      exportArtifact(
        {
          content: '<svg><foreignObject/></svg>',
          mode: 'svg-preview',
          title: 'x.svg',
          format: 'png'
        },
        deps
      )
    ).rejects.toThrow("This SVG embeds HTML, which can't be turned into a PNG on this device.")
    expect(share).not.toHaveBeenCalled()
  })
})

describe('exportArtifact: what it refuses', () => {
  it('a format the mode has no export for', async () => {
    await expect(
      exportArtifact(
        { content: '<p/>', mode: 'html-preview', title: 'r.html', format: 'png' },
        renderer()
      )
    ).rejects.toThrow("PNG export isn't available for HTML Preview artifacts.")
  })

  it('an empty artifact', async () => {
    await expect(
      exportArtifact(
        { content: '  \n', mode: 'markdown', title: 'e.md', format: 'pdf' },
        renderer()
      )
    ).rejects.toThrow('This artifact is empty: there is nothing to export.')
    expect(print).not.toHaveBeenCalled()
  })

  it("the printer's failure reaches the caller", async () => {
    print.mockRejectedValue(new Error('PDF not rendered'))
    await expect(
      exportArtifact({ content: '# A', mode: 'markdown', title: 'a.md', format: 'pdf' }, renderer())
    ).rejects.toThrow('PDF not rendered')
    expect(share).not.toHaveBeenCalled()
  })
})
