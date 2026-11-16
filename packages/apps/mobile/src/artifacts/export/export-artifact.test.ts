import {
  buildDocumentHtml,
  buildDrawnMermaidDocumentHtml
} from '@slayzone/task-artifacts/export-html'
import { printToFileAsync } from 'expo-print'
import { shareAsync } from 'expo-sharing'
import {
  EXPORT_DIR,
  type ExportArtifactDeps,
  exportArtifact,
  TEXT_LABELS_NOTICE
} from './export-artifact'
import type { ExportPageSink, ExportRenderPage, ExportRenderReply } from './render-pages'

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
      mockFs.bytes.delete(this.uri)
    }
    async move(to: { uri: string }) {
      mockFs.log.push(['move', this.uri, to.uri])
      this.uri = to.uri
    }
    open(mode: string) {
      const uri = this.uri
      mockFs.log.push(['open', uri, mode])
      if (mode === 'wt' || !mockFs.bytes.has(uri)) mockFs.bytes.set(uri, [])
      let open = true
      return {
        writeBytesSync(bytes: Uint8Array) {
          if (!open) throw new Error('closed')
          mockFs.bytes.get(uri)?.push(bytes.slice())
        },
        close() {
          open = false
          mockFs.log.push(['close', uri])
        }
      }
    }
  }
  return {
    Directory: FakeDirectory,
    File: FakeFile,
    FileMode: { Truncate: 'wt', WriteOnly: 'w' },
    Paths: { cache: { uri: 'file:///cache/' } }
  }
})

const mockFs = {
  dirs: new Set<string>(),
  files: new Map<string, { content: string; encoding: string }>(),
  /** What was written through a file handle (`File.open`), chunk by chunk. */
  bytes: new Map<string, Uint8Array[]>(),
  log: [] as unknown[][]
}
/** A file written through its handle, as text (a PDF's structure is ASCII). */
const bytesOf = (uri: string) =>
  (mockFs.bytes.get(uri) ?? []).map((b) => Buffer.from(b).toString('latin1')).join('')
const OUT = `file:///cache/${EXPORT_DIR}`
/** `<OUT>/<this export's own folder>/<name>`. */
const inExportDir = (name: string) =>
  new RegExp(`^${OUT.replace(/[/.]/g, '\\$&')}/[^/]+/${name.replace('.', '\\.')}$`)

const print = jest.mocked(printToFileAsync)

/** A document as `printDocument` carries it: a string in its script, never markup. */
const asData = (html: string) =>
  JSON.stringify(html).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
const share = jest.mocked(shareAsync)

/** An html artifact's page pictures, drawn: handed to the render's sink one by one. */
interface Drawn {
  drawn: string[]
  textLabels: boolean
}
const drawn = (pages: string[], textLabels = false): Drawn => ({ drawn: pages, textLabels })

/** A renderer that answers each page with the next reply, and the pages it got. */
function renderer(
  ...replies: (ExportRenderReply | Drawn)[]
): ExportArtifactDeps & { pages: string[]; rendered: ExportRenderPage[] } {
  const pages: string[] = []
  const rendered: ExportRenderPage[] = []
  return {
    pages,
    rendered,
    render: jest.fn(async (page: ExportRenderPage, sink?: ExportPageSink) => {
      pages.push(page.html)
      rendered.push(page)
      const reply = replies.shift()
      if (!reply) throw new Error('unexpected render')
      if (!('drawn' in reply)) return reply
      if (!sink) throw new Error('pages drawn with nowhere to go')
      reply.drawn.forEach((picture, i) => sink.page(i, picture))
      return { type: 'pages' as const, count: reply.drawn.length, textLabels: reply.textLabels }
    }),
    mermaidScript: jest.fn(async () => 'globalThis.mermaid={/*bundle*/}'),
    html2canvasScript: jest.fn(async () => 'window.html2canvas=function(){/*bundle*/}'),
    onNotice: jest.fn()
  }
}

beforeEach(() => {
  mockFs.dirs.clear()
  mockFs.files.clear()
  mockFs.bytes.clear()
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
      html: expect.any(String),
      width: 595,
      height: 842,
      margins: { left: 28, right: 28, top: 28, bottom: 28 }
    })
    // Review 9, F2 (d): the shared document, handed over as data its HTML parser never
    // sees (print-document.test.ts runs it): nothing in it can navigate expo-print's view.
    const printed = print.mock.calls[0][0]?.html ?? ''
    expect(printed).toContain(asData(buildDocumentHtml('# Plan', 'markdown', 'plan.md')))
    expect(printed).not.toContain('<h1')
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
    const html = print.mock.calls[0][0]?.html ?? ''
    // Laid out like desktop's mermaid PDF, with the diagram already drawn — handed over as
    // data (Review 9, F2 (d)): the drawn SVG is never parsed by the printer's parser.
    expect(html).toContain(
      asData(buildDrawnMermaidDocumentHtml('<svg id="drawn"></svg>', 'flow.mmd'))
    )
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('<pre')
  })

  // Review 6, #4 / review 7, #1–#2: an html artifact runs in the hidden web view, in the
  // viewer's sandbox, and is drawn there page by page; the PDF is those pictures only —
  // expo-print's web view never parses anything the artifact wrote.
  describe('an html artifact', () => {
    const report = {
      content: '<div id="chart"></div><script>draw()</script>',
      mode: 'html-preview' as const,
      title: 'report.html',
      format: 'pdf' as const
    }
    /** A 1x1 picture, as a canvas gives it (RGBA). */
    const PICTURE =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const PAGES = [PICTURE, PICTURE]

    // Follow-up N3: the pages are written into the PDF as they come (`pages-pdf.ts`),
    // never held together: expo-print, which takes one HTML string with every picture
    // in it, is not used for them.
    it('writes the pages its scripts drew into the PDF as they come, pictures and nothing else', async () => {
      const deps = renderer(drawn(PAGES))
      const uri = await exportArtifact(report, deps)
      // Rendered in the host page with html2canvas, at the printed page's width.
      expect(deps.rendered).toHaveLength(1)
      expect(deps.html2canvasScript).toHaveBeenCalledTimes(1)
      expect(deps.pages[0]).toContain('<script>window.html2canvas=function(){/*bundle*/}</script>')
      expect(deps.pages[0]).toContain('sandbox="allow-scripts"')
      expect(deps.rendered[0].viewport).toEqual({ width: 539, height: 780 })
      expect(print).not.toHaveBeenCalled()
      expect(uri).toMatch(inExportDir('report.pdf'))
      const pdf = bytesOf(uri)
      expect(pdf.startsWith('%PDF-1.4\n')).toBe(true)
      expect(pdf.endsWith('%%EOF\n')).toBe(true)
      expect(pdf).toContain('/Type /Pages /Kids [5 0 R 8 0 R] /Count 2')
      expect(pdf.match(/\/Subtype \/Image/g)).toHaveLength(2)
      expect(pdf).not.toContain('chart')
      expect(pdf).not.toContain('draw()')
      // Opened truncated, written, closed; shared once whole.
      expect(mockFs.log).toContainEqual(['open', uri, 'wt'])
      expect(mockFs.log).toContainEqual(['close', uri])
      expect(share).toHaveBeenCalledWith(
        uri,
        expect.objectContaining({ mimeType: 'application/pdf' })
      )
      expect(deps.mermaidScript).not.toHaveBeenCalled()
      expect(deps.onNotice).not.toHaveBeenCalled()
    })

    // Review 9, F4: drawn again with an SVG's HTML labels as text (WebKit tainted the
    // drawing): exported, and the person told the labels may look different — under the
    // toolbar, before the share sheet opens.
    it('drawn with text labels: exported, with a notice before the share sheet', async () => {
      const deps = renderer(drawn(PAGES, true))
      const order: string[] = []
      deps.onNotice = (notice: string) => {
        order.push(notice)
      }
      share.mockImplementationOnce(async () => {
        order.push('share')
      })
      const uri = await exportArtifact(report, deps)
      expect(bytesOf(uri)).toContain('/Count 2')
      expect(order).toEqual([TEXT_LABELS_NOTICE, 'share'])
      expect(TEXT_LABELS_NOTICE).toMatch(/labels/i)
    })

    it('a page WebKit refuses to read back (even with text labels) says so, printing nothing', async () => {
      const deps = renderer({ type: 'error', code: 'tainted', message: 'tainted' })
      await expect(exportArtifact(report, deps)).rejects.toThrow(
        "This page draws something this device won't let the export read back"
      )
      expect(print).not.toHaveBeenCalled()
    })

    it("fails with the page's error, printing nothing", async () => {
      const deps = renderer({ type: 'error', code: 'render', message: 'no body' })
      await expect(exportArtifact(report, deps)).rejects.toThrow(
        "Couldn't render the page: no body"
      )
      expect(print).not.toHaveBeenCalled()
      expect(share).not.toHaveBeenCalled()
    })

    it('a render that never answers fails the export (the renderer gave up), printing nothing', async () => {
      const deps = renderer()
      deps.render = jest.fn(async () => {
        throw new Error('Rendering the export took too long.')
      })
      await expect(exportArtifact(report, deps)).rejects.toThrow(
        'Rendering the export took too long.'
      )
      expect(print).not.toHaveBeenCalled()
    })

    it('drawn again from the top (a restart): only the second drawing is in the PDF', async () => {
      const deps = renderer()
      deps.render = jest.fn(async (_page: ExportRenderPage, sink?: ExportPageSink) => {
        sink?.page(0, PICTURE)
        sink?.page(1, PICTURE)
        sink?.restart()
        sink?.page(0, PICTURE)
        return { type: 'pages' as const, count: 1, textLabels: true }
      })
      const uri = await exportArtifact(report, deps)
      const pdf = bytesOf(uri)
      expect(pdf.match(/%PDF-1\.4/g)).toHaveLength(1)
      expect(pdf).toContain('/Count 1')
      expect(pdf.match(/\/Subtype \/Image/g)).toHaveLength(1)
    })

    it('a page count the PDF does not hold fails the export, its file removed', async () => {
      const deps = renderer()
      deps.render = jest.fn(async (_page: ExportRenderPage, sink?: ExportPageSink) => {
        sink?.page(0, PICTURE)
        return { type: 'pages' as const, count: 2, textLabels: false }
      })
      await expect(exportArtifact(report, deps)).rejects.toThrow(/1 of its 2 pages/)
      expect(mockFs.bytes.size).toBe(0)
      expect(share).not.toHaveBeenCalled()
    })

    it('a failed render leaves no partial PDF, its file closed', async () => {
      const deps = renderer()
      deps.render = jest.fn(async (_page: ExportRenderPage, sink?: ExportPageSink) => {
        sink?.page(0, PICTURE)
        return { type: 'error' as const, code: 'render' as const, message: 'no body' }
      })
      await expect(exportArtifact(report, deps)).rejects.toThrow(
        "Couldn't render the page: no body"
      )
      expect(mockFs.bytes.size).toBe(0)
      expect(mockFs.log.filter((e) => e[0] === 'close')).toHaveLength(1)
    })

    it('a reply of another kind is no page', async () => {
      const deps = renderer({ type: 'svg', svg: '<svg/>' })
      await expect(exportArtifact(report, deps)).rejects.toThrow(
        "Couldn't render the page: no page came back."
      )
      expect(print).not.toHaveBeenCalled()
    })
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

// Review 9, L4: the viewer closed after the render step: the export stops, and the share
// sheet never opens over whatever screen is shown by then.
describe('exportArtifact: the viewer closed (its abort signal)', () => {
  const report = {
    content: '<p>r</p>',
    mode: 'html-preview' as const,
    title: 'r.html',
    format: 'pdf' as const
  }
  const CANCELLED = 'The export was cancelled: the viewer was closed.'

  it('closed while the page rendered: nothing is printed or shared', async () => {
    const controller = new AbortController()
    const deps = renderer()
    deps.render = jest.fn(async () => {
      controller.abort()
      return { type: 'pages' as const, count: 1, textLabels: false }
    })
    await expect(exportArtifact(report, { ...deps, signal: controller.signal })).rejects.toThrow(
      CANCELLED
    )
    expect(print).not.toHaveBeenCalled()
    expect(share).not.toHaveBeenCalled()
    // The PDF begun for its pages is removed.
    expect(mockFs.bytes.size).toBe(0)
  })

  it('closed while printing: the PDF is removed, the share sheet never opens', async () => {
    const controller = new AbortController()
    let land: (r: { uri: string; numberOfPages: number }) => void = () => undefined
    print.mockImplementationOnce(() => new Promise((r) => (land = r)))
    const done = exportArtifact(
      { content: '# x', mode: 'markdown', title: 'p.md', format: 'pdf' },
      { ...renderer(), signal: controller.signal }
    )
    await new Promise((r) => setTimeout(r, 0))
    controller.abort()
    land({ uri: 'file:///cache/Print/late.pdf', numberOfPages: 1 })
    await expect(done).rejects.toThrow(CANCELLED)
    expect(mockFs.log).toContainEqual(['rm', 'file:///cache/Print/late.pdf'])
    expect(mockFs.log).not.toContainEqual([
      'move',
      'file:///cache/Print/late.pdf',
      expect.anything()
    ])
    expect(share).not.toHaveBeenCalled()
  })

  it('closed before it began: nothing at all', async () => {
    const controller = new AbortController()
    controller.abort()
    const deps = { ...renderer(), signal: controller.signal }
    await expect(
      exportArtifact({ content: '# x', mode: 'markdown', title: 'p.md', format: 'html' }, deps)
    ).rejects.toThrow(CANCELLED)
    expect(mockFs.files.size).toBe(0)
    expect(share).not.toHaveBeenCalled()
  })

  it('closed while a PNG was drawn: nothing written or shared', async () => {
    const controller = new AbortController()
    const deps = renderer()
    deps.render = jest.fn(async () => {
      controller.abort()
      return { type: 'png' as const, base64: 'UE5H', width: 1, height: 1 }
    })
    await expect(
      exportArtifact(
        { content: '<svg/>', mode: 'svg-preview', title: 'l.svg', format: 'png' },
        { ...deps, signal: controller.signal }
      )
    ).rejects.toThrow(CANCELLED)
    expect(mockFs.files.size).toBe(0)
    expect(share).not.toHaveBeenCalled()
  })

  // Follow-up N2: the viewer closed while the bundled script was first read from disk.
  // The export stops there: no render is asked for (it would never settle), and the
  // export settles, its folder no longer protected from the next sweep.
  const firstReads = [
    {
      name: 'html → PDF (html2canvas)',
      request: { content: '<p>r</p>', mode: 'html-preview', title: 'r.html', format: 'pdf' },
      script: 'html2canvasScript'
    },
    {
      name: 'mermaid → PDF',
      request: {
        content: 'graph TD; A-->B',
        mode: 'mermaid-preview',
        title: 'd.mmd',
        format: 'pdf'
      },
      script: 'mermaidScript'
    },
    {
      name: 'mermaid → PNG',
      request: {
        content: 'graph TD; A-->B',
        mode: 'mermaid-preview',
        title: 'd.mmd',
        format: 'png'
      },
      script: 'mermaidScript'
    },
    {
      name: 'mermaid → HTML',
      request: {
        content: 'graph TD; A-->B',
        mode: 'mermaid-preview',
        title: 'd.mmd',
        format: 'html'
      },
      script: 'mermaidScript'
    }
  ] as const

  it.each(firstReads)(
    '$name: closed during the script read, no render is asked for',
    async ({ request, script }) => {
      const controller = new AbortController()
      const deps = renderer()
      deps[script] = jest.fn(async () => {
        controller.abort()
        return '/* bundle */'
      })
      await expect(exportArtifact(request, { ...deps, signal: controller.signal })).rejects.toThrow(
        CANCELLED
      )
      expect(deps.render).not.toHaveBeenCalled()
      expect(print).not.toHaveBeenCalled()
      expect(share).not.toHaveBeenCalled()
    }
  )

  it.each(firstReads)(
    '$name: a script read that never ends still ends the export on close',
    async ({ request, script }) => {
      const controller = new AbortController()
      const deps = renderer()
      deps[script] = jest.fn(() => new Promise<string>(() => undefined))
      const done = exportArtifact(request, { ...deps, signal: controller.signal })
      await new Promise((r) => setTimeout(r, 0))
      controller.abort()
      await expect(done).rejects.toThrow(CANCELLED)
      expect(deps.render).not.toHaveBeenCalled()
      expect(share).not.toHaveBeenCalled()
    }
  )

  it('a render that never settles still ends the export on close, and its folder is swept next time', async () => {
    mockFs.dirs.add(OUT)
    const controller = new AbortController()
    const deps = renderer()
    deps.render = jest.fn(() => new Promise<ExportRenderReply>(() => undefined))
    const done = exportArtifact(report, { ...deps, signal: controller.signal })
    await new Promise((r) => setTimeout(r, 0))
    const [, firstDir] =
      mockFs.log.find((e) => e[0] === 'mkdir' && String(e[1]).startsWith(`${OUT}/`)) ?? []
    controller.abort()
    await expect(done).rejects.toThrow(CANCELLED)
    await exportArtifact(
      { content: '# x', mode: 'markdown', title: 'n.md', format: 'html' },
      renderer()
    )
    expect(mockFs.log).toContainEqual(['rmdir', firstDir])
  })
})
