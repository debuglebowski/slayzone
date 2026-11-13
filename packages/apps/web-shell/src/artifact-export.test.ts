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
vi.mock('mermaid', () => ({ default: { render } }))

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

  it('prints PDF from a script-free sandboxed frame', async () => {
    const frames = captureFrames()
    void exportArtifactInBrowser({ format: 'pdf', mode: 'markdown', title: 'n.md', content: '# x' })
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    const frame = frames[0]
    // Same origin so this page can print it; NO allow-scripts, so the artifact's own
    // scripts never run with this page's origin.
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-modals')
    expect(frame.srcdoc).toContain('<h1>x</h1>')
    expect(frame.srcdoc).not.toContain('<script')
    frame.remove()
  })

  it('draws mermaid in the page (light theme, dagre) and prints the static SVG', async () => {
    const frames = captureFrames()
    void exportArtifactInBrowser({
      format: 'pdf',
      mode: 'mermaid-preview',
      title: 'd.mmd',
      content: 'graph TD; A-->B'
    })
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    expect(render.mock.calls[0][1]).toBe(
      '%%{init: {"theme": "default", "layout": "dagre"}}%%\ngraph TD; A-->B'
    )
    expect(frames[0].srcdoc).toContain('<pre class="mermaid"><svg id="drawn"></svg></pre>')
    expect(frames[0].srcdoc).not.toContain('<script')
    frames[0].remove()
  })

  it('reports a diagram that does not parse', async () => {
    render.mockRejectedValueOnce(new Error('Parse error on line 1'))
    await expect(
      exportArtifactInBrowser({ format: 'png', mode: 'mermaid-preview', title: 'd', content: '?' })
    ).resolves.toEqual({ ok: false, error: 'Parse error on line 1' })
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

  it('the light theme with plain-text labels is what the fallback asks mermaid for', async () => {
    render.mockClear()
    const { drawMermaidSvg } = await import('./artifact-export')
    await drawMermaidSvg('graph TD', { htmlLabels: false })
    const code = render.mock.calls[0][1]
    expect(code).toContain('"htmlLabels": false')
    expect(code).toContain('"flowchart": {"htmlLabels": false}')
  })
})
