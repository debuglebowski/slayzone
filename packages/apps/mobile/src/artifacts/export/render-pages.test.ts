import { runInNewContext } from 'node:vm'
import {
  EXPORT_RENDER_SOURCE,
  type ExportRenderReply,
  mermaidSvgPage,
  parseExportRenderReply,
  pngCapturePage
} from './render-pages'

/** The page's inline scripts, in order (what the web view runs). */
function scriptsOf(html: string): string[] {
  return [...html.matchAll(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/g)].map((m) => m[2])
}

/** The nonce the page's policy allows; every script must carry it. */
function policyNonce(html: string): string {
  const m = /script-src 'nonce-([^']+)'/.exec(html)
  if (!m) throw new Error('no nonce in the policy')
  return m[1]
}

/** Runs the page's scripts against `globals`; resolves with the first reply it posts. */
function runPage(html: string, globals: Record<string, unknown>): Promise<ExportRenderReply> {
  return new Promise((resolve, reject) => {
    const context = {
      ...globals,
      window: {
        ReactNativeWebView: {
          postMessage: (data: string) => {
            const reply = parseExportRenderReply(data)
            if (reply) resolve(reply)
            else reject(new Error(`unparseable reply: ${data}`))
          }
        }
      }
    }
    for (const script of scriptsOf(html)) runInNewContext(script, context)
  })
}

describe('parseExportRenderReply', () => {
  const msg = (body: object) => JSON.stringify({ source: EXPORT_RENDER_SOURCE, ...body })

  it('reads the three replies', () => {
    expect(parseExportRenderReply(msg({ type: 'svg', svg: '<svg/>' }))).toEqual({
      type: 'svg',
      svg: '<svg/>'
    })
    expect(
      parseExportRenderReply(msg({ type: 'png', base64: 'AAA', width: 20, height: 10 }))
    ).toEqual({ type: 'png', base64: 'AAA', width: 20, height: 10 })
    expect(parseExportRenderReply(msg({ type: 'error', code: 'tainted', message: 'no' }))).toEqual({
      type: 'error',
      code: 'tainted',
      message: 'no'
    })
  })

  it('ignores anything else: not JSON, another source, a malformed reply', () => {
    expect(parseExportRenderReply('not json')).toBeNull()
    expect(parseExportRenderReply(JSON.stringify({ type: 'svg', svg: '<svg/>' }))).toBeNull()
    expect(parseExportRenderReply(msg({ type: 'svg' }))).toBeNull()
    expect(parseExportRenderReply(msg({ type: 'png', base64: 'A', width: '1' }))).toBeNull()
    expect(parseExportRenderReply(msg({ type: 'error', code: 'boom', message: '' }))).toBeNull()
    expect(parseExportRenderReply(msg({ type: 'other' }))).toBeNull()
  })
})

describe('mermaidSvgPage: draws the diagram and posts it back as static SVG', () => {
  const fakeMermaid = 'globalThis.mermaid = globalThis.__fakeMermaid'

  function fakeSvg() {
    const attrs: Record<string, string> = { width: '100%' }
    return {
      attrs,
      style: { maxWidth: '512px', height: '' } as Record<string, string>,
      viewBox: { baseVal: { width: 300, height: 120 } },
      setAttribute: (k: string, v: string) => {
        attrs[k] = String(v)
      },
      removeAttribute: (k: string) => {
        delete attrs[k]
      },
      get outerHTML() {
        return `<svg ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ')}></svg>`
      }
    }
  }

  function page(render: (id: string, source: string) => Promise<{ svg: string }>) {
    const svg = fakeSvg()
    const initialize = jest.fn()
    const host = { innerHTML: '', querySelector: () => svg }
    const globals = {
      __fakeMermaid: { initialize, render: jest.fn(render) },
      document: { getElementById: (id: string) => (id === 'export-host' ? host : null) }
    }
    return { svg, initialize, host, globals, mermaid: globals.__fakeMermaid }
  }

  it('renders the source with the export options, sizes the SVG to its viewBox', async () => {
    const p = page(async () => ({ svg: '<svg>drawn</svg>' }))
    const html = mermaidSvgPage('graph TD; A-->B </script>', fakeMermaid, { htmlLabels: true })
    const nonce = policyNonce(html)
    expect(scriptsOf(html)).toHaveLength(2)
    expect(html.match(/<script nonce="/g)).toHaveLength(2)
    expect(html).toContain(`nonce="${nonce}"`)
    // The source travels as a script string, never as markup.
    expect(html).not.toContain('</script>"')

    const reply = await runPage(html, p.globals)
    expect(p.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'default', layout: 'dagre', securityLevel: 'strict' })
    )
    expect(p.initialize.mock.calls[0][0]).toHaveProperty('htmlLabels', true)
    expect(p.mermaid.render).toHaveBeenCalledWith(expect.any(String), 'graph TD; A-->B </script>')
    expect(p.host.innerHTML).toBe('<svg>drawn</svg>')
    expect(reply).toEqual({
      type: 'svg',
      svg: expect.stringContaining('width="300" height="120"')
    })
    expect(p.svg.style.maxWidth).toBe('100%')
    expect(p.svg.style.height).toBe('auto')
  })

  it('labels as plain SVG text when asked (no foreignObject)', async () => {
    const p = page(async () => ({ svg: '<svg/>' }))
    await runPage(mermaidSvgPage('graph TD; A', fakeMermaid, { htmlLabels: false }), p.globals)
    expect(p.initialize).toHaveBeenCalledWith(expect.objectContaining({ htmlLabels: false }))
  })

  it("posts mermaid's error when the source doesn't parse", async () => {
    const p = page(async () => {
      throw new Error('Parse error on line 1')
    })
    const reply = await runPage(
      mermaidSvgPage('nope', fakeMermaid, { htmlLabels: true }),
      p.globals
    )
    expect(reply).toEqual({ type: 'error', code: 'render', message: 'Parse error on line 1' })
  })
})

describe('pngCapturePage: rasterises the SVG at 2x and posts the PNG back', () => {
  function capture(options: {
    svgAttrs: Record<string, string>
    viewBox?: { width: number; height: number } | null
    rect?: { width: number; height: number }
    imageFails?: boolean
    toDataURL?: () => string
  }) {
    const drawn: unknown[] = []
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        scale: (...a: unknown[]) => drawn.push(['scale', ...a]),
        fillRect: (...a: unknown[]) => drawn.push(['fillRect', ...a]),
        drawImage: (...a: unknown[]) => drawn.push(['drawImage', ...a.slice(1)]),
        set fillStyle(v: string) {
          drawn.push(['fillStyle', v])
        }
      }),
      toDataURL: jest.fn(options.toDataURL ?? (() => 'data:image/png;base64,UE5H'))
    }
    const clone = { setAttribute: jest.fn(), style: {} as Record<string, string> }
    const svg = {
      getAttribute: (k: string) => options.svgAttrs[k] ?? null,
      viewBox: { baseVal: options.viewBox ?? null },
      getBoundingClientRect: () => options.rect ?? { width: 0, height: 0 },
      cloneNode: () => clone
    }
    let loaded = ''
    class FakeImage {
      onload?: () => void
      onerror?: () => void
      set src(v: string) {
        loaded = v
        setTimeout(() => (options.imageFails ? this.onerror?.() : this.onload?.()), 0)
      }
    }
    const globals = {
      document: {
        querySelector: (s: string) => (s === 'svg' ? svg : null),
        createElement: (t: string) => (t === 'canvas' ? canvas : null)
      },
      XMLSerializer: class {
        serializeToString() {
          return '<svg xmlns="http://www.w3.org/2000/svg">x</svg>'
        }
      },
      Image: FakeImage
    }
    return { globals, canvas, clone, drawn, loaded: () => loaded }
  }

  it('uses the SVG’s own size, draws it on white at 2x', async () => {
    const c = capture({ svgAttrs: { width: '200', height: '100px' } })
    const html = pngCapturePage('<svg width="200" height="100px"></svg>', 'logo.svg')
    expect(html).toContain('<svg width="200" height="100px"></svg>')
    expect(html).toContain(`script-src 'nonce-${policyNonce(html)}'`)
    const reply = await runPage(html, c.globals)
    expect(reply).toEqual({ type: 'png', base64: 'UE5H', width: 400, height: 200 })
    expect(c.clone.setAttribute).toHaveBeenCalledWith('width', '200')
    expect(c.clone.setAttribute).toHaveBeenCalledWith('height', '100')
    expect(c.loaded()).toBe(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg">x</svg>')}`
    )
    expect(c.canvas.width).toBe(400)
    expect(c.canvas.height).toBe(200)
    expect(c.drawn).toEqual([
      ['scale', 2, 2],
      ['fillStyle', 'white'],
      ['fillRect', 0, 0, 200, 100],
      ['drawImage', 0, 0, 200, 100]
    ])
  })

  it('falls back to the viewBox, then to the laid-out box', async () => {
    const byViewBox = capture({ svgAttrs: { width: '100%' }, viewBox: { width: 30, height: 15 } })
    expect(await runPage(pngCapturePage('<svg/>', 't'), byViewBox.globals)).toMatchObject({
      width: 60,
      height: 30
    })
    const byRect = capture({ svgAttrs: {}, rect: { width: 50.2, height: 20 } })
    expect(await runPage(pngCapturePage('<svg/>', 't'), byRect.globals)).toMatchObject({
      width: 102,
      height: 40
    })
  })

  it('scales down a drawing too big for one canvas', async () => {
    const c = capture({ svgAttrs: { width: '4000', height: '4000' } })
    const reply = await runPage(pngCapturePage('<svg/>', 't'), c.globals)
    expect(reply.type).toBe('png')
    expect(c.canvas.width * c.canvas.height).toBeLessThanOrEqual(16_000_000)
    expect(c.canvas.width).toBe(c.canvas.height)
  })

  it('says so when WebKit refuses to read the canvas back (an SVG with HTML in it)', async () => {
    const c = capture({
      svgAttrs: { width: '10', height: '10' },
      toDataURL: () => {
        throw new Error('SecurityError: The operation is insecure.')
      }
    })
    expect(await runPage(pngCapturePage('<svg/>', 't'), c.globals)).toEqual({
      type: 'error',
      code: 'tainted',
      message: 'SecurityError: The operation is insecure.'
    })
  })

  it("says so when the SVG can't be drawn", async () => {
    const c = capture({ svgAttrs: { width: '10', height: '10' }, imageFails: true })
    expect(await runPage(pngCapturePage('<svg/>', 't'), c.globals)).toMatchObject({
      type: 'error',
      code: 'render'
    })
    const empty = capture({ svgAttrs: { width: '10', height: '10' }, toDataURL: () => 'data:,' })
    expect(await runPage(pngCapturePage('<svg/>', 't'), empty.globals)).toMatchObject({
      type: 'error',
      code: 'render'
    })
  })

  it('posts an error for a page with no SVG', async () => {
    const c = capture({ svgAttrs: {} })
    c.globals.document.querySelector = () => null
    expect(await runPage(pngCapturePage('<p>no</p>', 't'), c.globals)).toMatchObject({
      type: 'error',
      code: 'render'
    })
  })
})
