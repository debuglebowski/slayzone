/**
 * @vitest-environment jsdom
 *
 * web-shell's artifact export. jsdom lays nothing out and has no canvas, so this covers
 * routing, the downloaded HTML and the print frame's isolation; rendering itself is
 * proved in a real browser under the hub's CSP.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('mermaid/dist/mermaid.min.js?url', () => ({ default: '/assets/mermaid.min.js' }))
const render = vi.fn(async (_id: string, _code: string) => ({ svg: '<svg id="drawn"></svg>' }))
const parse = vi.fn(async (_code: string) => ({ diagramType: 'flowchart-v2', config: {} }))
vi.mock('mermaid', () => ({ default: { render, parse } }))

import { TaintedCanvasError, exportArtifactInBrowser } from './artifact-export'

const clicked: { name: string; blob: Blob }[] = []

beforeEach(() => {
  clicked.length = 0
  let n = 0
  const blobs = new Map<string, Blob>()
  URL.createObjectURL = vi.fn((b: Blob) => {
    const url = `blob:test/${++n}`
    blobs.set(url, b as Blob)
    return url
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicked.push({ name: this.download, blob: blobs.get(this.href) as Blob })
  })
  globalThis.fetch = vi.fn(async () => new Response('/*mermaid build*/', { status: 200 }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('exportArtifactInBrowser', () => {
  it('downloads the HTML document under the artifact name', async () => {
    const res = await exportArtifactInBrowser({
      format: 'html',
      mode: 'markdown',
      title: 'notes.md',
      content: '# Hi'
    })
    expect(res).toEqual({ ok: true })
    expect(clicked).toHaveLength(1)
    expect(clicked[0].name).toBe('notes.html')
    expect(clicked[0].blob.type).toBe('text/html')
    expect(await clicked[0].blob.text()).toContain('<h1>Hi</h1>')
  })

  it('embeds the served mermaid build in a mermaid HTML export', async () => {
    await exportArtifactInBrowser({
      format: 'html',
      mode: 'mermaid-preview',
      title: 'd.mmd',
      content: 'graph TD'
    })
    expect(globalThis.fetch).toHaveBeenCalledWith('/assets/mermaid.min.js')
    expect(await clicked[0].blob.text()).toContain('/*mermaid build*/')
  })

  it('refuses a format the mode has no export for', async () => {
    const res = await exportArtifactInBrowser({
      format: 'png',
      mode: 'markdown',
      title: 'notes.md',
      content: '# Hi'
    })
    expect(res).toEqual({ ok: false, error: 'Cannot export markdown as PNG' })
    expect(clicked).toHaveLength(0)
  })

  it('reports a diagram that does not parse', async () => {
    render.mockRejectedValueOnce(new Error('Parse error on line 1'))
    await expect(
      exportArtifactInBrowser({ format: 'png', mode: 'mermaid-preview', title: 'd', content: '?' })
    ).resolves.toEqual({ ok: false, error: 'Parse error on line 1' })
  })
})

// Review 5, #4/#8: a PDF is printed in the hub's export frame (hub export-frame.ts), on an
// opaque origin, where the document renders as written: an html artifact's own scripts
// and remote styles, markdown's remote images, mermaid drawn by its inlined build. The
// frame's real behaviour is proved in a browser (e2e 207); this is the shell's side.
describe('PDF through the export frame', () => {
  /** Start a PDF export; resolves with its frame once the shell has created it. */
  async function startPdf(req: { mode: string; content: string; title?: string }) {
    const frames = captureFrames()
    const result = exportArtifactInBrowser({ format: 'pdf', title: 'n.md', ...req })
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    const frame = frames[0]
    const win = frame.contentWindow as Window
    const posted: { message: Record<string, unknown>; target: string }[] = []
    win.postMessage = ((message: Record<string, unknown>, target: string) => {
      posted.push({ message, target })
    }) as typeof win.postMessage
    const say = (data: unknown, source: Window | null = win) =>
      window.dispatchEvent(new MessageEvent('message', { data, source }))
    return { frame, result, posted, say }
  }

  it('loads the hub page in a frame with scripts but no origin, and prints the document', async () => {
    const { frame, result, posted, say } = await startPdf({ mode: 'markdown', content: '# x' })
    // Scripts run in it; WITHOUT allow-same-origin, so never with this page's origin.
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-modals')
    expect(new URL(frame.src).pathname).toBe('/export-frame')
    expect(frame.hasAttribute('srcdoc')).toBe(false)
    expect(posted).toEqual([])

    say({ slayzoneExportFrame: 1 })
    expect(posted).toHaveLength(1)
    const { message, target } = posted[0]
    // An opaque origin has no name to address it by.
    expect(target).toBe('*')
    expect(message.waitForReady).toBe(false)
    expect(message.html).toContain('<h1>x</h1>')
    // The markdown document keeps its own policy: its markup runs no script.
    expect(message.html).toContain("script-src 'none'")

    const id = message.slayzoneExport
    say({ slayzoneExport: id, state: 'ready', images: { total: 0, loaded: 0 } })
    expect(frame.isConnected).toBe(true)
    say({ slayzoneExport: id, state: 'done' })
    await expect(result).resolves.toEqual({ ok: true })
    expect(frame.isConnected).toBe(false)
  })

  it('an html artifact goes to the frame as written: its scripts and styles included', async () => {
    const page =
      '<html><head><link rel="stylesheet" href="https://cdn.example/x.css"></head>' +
      '<body><canvas id="c"></canvas><script src="https://cdn.example/chart.js"></script>' +
      '<script>draw()</script></body></html>'
    const { posted, say, result } = await startPdf({ mode: 'html-preview', content: page })
    say({ slayzoneExportFrame: 1 })
    const html = posted[0].message.html as string
    expect(html).toContain('<script src="https://cdn.example/chart.js"></script>')
    expect(html).toContain('<script>draw()</script>')
    expect(html).not.toContain('Content-Security-Policy')
    say({ slayzoneExport: posted[0].message.slayzoneExport, state: 'done' })
    await expect(result).resolves.toEqual({ ok: true })
  })

  it('mermaid is drawn in the frame by the inlined build; the shell waits for it', async () => {
    render.mockClear()
    const { posted, say, result } = await startPdf({
      mode: 'mermaid-preview',
      content: '---\ntitle: T\n---\ngraph TD; A-->B'
    })
    say({ slayzoneExportFrame: 1 })
    const { message } = posted[0]
    expect(message.waitForReady).toBe(true)
    expect(message.html).toContain('/*mermaid build*/')
    expect(message.html).toContain(
      '<pre class="mermaid">---\ntitle: T\n---\ngraph TD; A--&gt;B</pre>'
    )
    expect(render).not.toHaveBeenCalled()
    say({ slayzoneExport: message.slayzoneExport, state: 'done' })
    await expect(result).resolves.toEqual({ ok: true })
  })

  it('a frame speaking another protocol version (a stale tab) asks for a reload', async () => {
    const { posted, say, result } = await startPdf({ mode: 'markdown', content: '# x' })
    say({ slayzoneExportFrame: 2 })
    expect(posted).toEqual([])
    await expect(result).resolves.toEqual({
      ok: false,
      error: 'This page is out of date. Reload it, then export again.'
    })
  })

  it('a failure the frame reports fails the export and removes the frame', async () => {
    const { frame, posted, say, result } = await startPdf({ mode: 'markdown', content: '# x' })
    say({ slayzoneExportFrame: 1 })
    say({ slayzoneExport: posted[0].message.slayzoneExport, state: 'error', message: 'boom' })
    await expect(result).resolves.toEqual({ ok: false, error: 'boom' })
    expect(frame.isConnected).toBe(false)
  })

  it('messages from anywhere but the frame, or for another export, are ignored', async () => {
    const { posted, say, result } = await startPdf({ mode: 'markdown', content: '# x' })
    say({ slayzoneExportFrame: 1 }, null)
    say({ slayzoneExportFrame: 1 }, window)
    expect(posted).toEqual([])
    say({ slayzoneExportFrame: 1 })
    const id = posted[0].message.slayzoneExport
    say({ slayzoneExport: 'other', state: 'error', message: 'not mine' })
    say({ slayzoneExport: id, state: 'done' }, null)
    say({ slayzoneExport: id, state: 'done' })
    await expect(result).resolves.toEqual({ ok: true })
  })

  it('a frame that never answers fails the export instead of waiting forever', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { frame, result } = await startPdf({ mode: 'markdown', content: '# x' })
      await vi.advanceTimersByTimeAsync(20_000)
      await expect(result).resolves.toEqual({
        ok: false,
        error: 'The print frame did not load'
      })
      expect(frame.isConnected).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

function captureFrames(): HTMLIFrameElement[] {
  const frames: HTMLIFrameElement[] = []
  const orig = document.body.appendChild.bind(document.body)
  vi.spyOn(document.body, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
    if (node instanceof HTMLIFrameElement) frames.push(node)
    return orig(node)
  })
  return frames
}

// WebKit (Safari) taints a canvas an SVG with HTML labels (<foreignObject>, which
// mermaid uses by default) was drawn on, so reading the PNG back throws SecurityError.
// Chromium does not, so the e2e group never sees it: the fallback is proved here.
describe('PNG on a tainting browser (WebKit)', () => {
  const pngBlob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })

  it('redraws a mermaid diagram with plain-text labels and exports that', async () => {
    const draws: { htmlLabels: boolean }[] = []
    const rasterise = vi
      .fn<(html: string) => Promise<Blob>>()
      .mockRejectedValueOnce(new TaintedCanvasError())
      .mockResolvedValueOnce(pngBlob)
    const res = await exportArtifactInBrowser(
      { format: 'png', mode: 'mermaid-preview', title: 'd.mmd', content: 'graph TD; A-->B' },
      {
        rasterise,
        drawMermaid: async (_code, opts) => {
          draws.push(opts)
          return opts.htmlLabels ? '<svg id="html"></svg>' : '<svg id="text"></svg>'
        }
      }
    )
    expect(res).toEqual({ ok: true })
    expect(draws).toEqual([{ htmlLabels: true }, { htmlLabels: false }])
    expect(rasterise.mock.calls[1][0]).toContain('<svg id="text"></svg>')
    expect(clicked[0].name).toBe('d.png')
  })

  it('an SVG artifact that embeds HTML gets a clear error', async () => {
    const res = await exportArtifactInBrowser(
      { format: 'png', mode: 'svg-preview', title: 'x.svg', content: '<svg></svg>' },
      {
        rasterise: async () => {
          throw new TaintedCanvasError()
        },
        drawMermaid: async () => ''
      }
    )
    expect(res).toEqual({
      ok: false,
      error: "This SVG embeds HTML, which this browser can't turn into a PNG."
    })
  })

  // Review 5, #3: mermaid takes frontmatter only at the very start.
  it('a diagram with frontmatter keeps it first, the directive after it', async () => {
    render.mockClear()
    const { drawMermaidSvg } = await import('./artifact-export')
    await drawMermaidSvg('---\ntitle: Flow\n---\ngraph TD; A-->B', { htmlLabels: true })
    expect(render.mock.calls[0][1]).toBe(
      '---\ntitle: Flow\n---\n%%{init: {"theme":"default","layout":"dagre"}}%%\ngraph TD; A-->B'
    )
  })

  it('the light theme with plain-text labels is what the fallback asks mermaid for', async () => {
    render.mockClear()
    const { drawMermaidSvg } = await import('./artifact-export')
    await drawMermaidSvg('graph TD', { htmlLabels: false })
    const code = render.mock.calls[0][1]
    expect(code).toContain('"htmlLabels":false')
    expect(code).toContain('"flowchart":{"htmlLabels":false}')
  })
})
