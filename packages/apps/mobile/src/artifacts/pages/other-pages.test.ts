import { HTML_PREVIEW_LINK_MESSAGE_TYPE } from '@slayzone/platform/html-preview-links'
import { testPageTheme } from '../testing'
import { codePage } from './code-page'
import { htmlReportPage, insertIntoHead } from './html-report-page'
import { mermaidPage } from './mermaid-page'
import { svgPage } from './svg-page'

const theme = testPageTheme('light')

/** The report as the sandboxed frame gets it (the srcdoc attribute, unescaped). */
function srcdocOf(page: string): string {
  const m = /srcdoc="([^"]*)"/.exec(page)
  if (!m) throw new Error('no srcdoc')
  return m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

describe('codePage', () => {
  it('shows the text escaped, one numbered, wrapping line per source line, no script', () => {
    const html = codePage('a < b\n\n</pre>', theme)
    expect(html.match(/<span class="l">/g)).toHaveLength(3)
    expect(html).toContain('<span class="l">a &lt; b</span>')
    expect(html).toContain('&lt;/pre&gt;')
    expect(html).toContain('white-space: pre-wrap')
    expect(html).toContain("script-src 'none'")
  })
})

describe('htmlReportPage', () => {
  it("runs the report in desktop's sandbox: scripts only, nothing else", () => {
    const page = htmlReportPage('<p>hi</p>', { forcedTheme: null }).html
    expect(page.match(/<iframe /g)).toHaveLength(1)
    expect(page).toContain('sandbox="allow-scripts"')
    expect(page).not.toContain('Content-Security-Policy')
  })

  it("gives the report desktop's link bridge, after <head> (doctype stays first)", () => {
    const report = '<!doctype html><html><head><title>R</title></head><body>x</body></html>'
    const doc = srcdocOf(htmlReportPage(report, { forcedTheme: null }).html)
    expect(doc.startsWith('<!doctype html><html><head><script>')).toBe(true)
    expect(doc).toContain(HTML_PREVIEW_LINK_MESSAGE_TYPE)
    expect(doc).toContain('<title>R</title></head><body>x</body></html>')
  })

  it("forces the report's colour scheme only when the artifact says so", () => {
    expect(srcdocOf(htmlReportPage('<p>x</p>', { forcedTheme: null }).html)).not.toContain(
      'slz-forced-theme'
    )
    expect(
      srcdocOf(
        htmlReportPage('<html><head></head><body></body></html>', { forcedTheme: 'dark' }).html
      )
    ).toContain(':root{color-scheme:dark !important}')
  })

  it('forwards only link messages from the report frame, while a tap is fresh, with its token', () => {
    const page = htmlReportPage('<p>x</p>', { forcedTheme: null })
    expect(page.token).toMatch(/^[a-z0-9]{12,}$/)
    // The token is only in the host's own script, never in the report the frame gets.
    expect(srcdocOf(page.html)).not.toContain(page.token)
    expect(htmlReportPage('<p>x</p>', { forcedTheme: null }).token).not.toBe(page.token)

    const host = runHost(page.html)
    const link = {
      type: HTML_PREVIEW_LINK_MESSAGE_TYPE,
      url: 'https://x.dev',
      metaKey: false,
      ctrlKey: false,
      shiftKey: false
    }
    host.post(link, host.frame)
    expect(host.sent.map((m) => JSON.parse(m))).toEqual([{ ...link, token: page.token }])

    host.post(link, {}) // another window
    host.post({ ...link, type: 'other' }, host.frame)
    host.activation.isActive = false
    host.post(link, host.frame)
    expect(host.sent).toHaveLength(1)
  })
})

/** Runs the host page's script against a stand-in window, frame and native bridge. */
function runHost(html: string) {
  const script = /<\/iframe><script>([\s\S]*)<\/script><\/body>/.exec(html)?.[1]
  if (!script) throw new Error('no host script')
  const frame = { contentWindow: {} }
  const sent: string[] = []
  const activation = { isActive: true }
  let listener: ((e: { source: unknown; data: unknown }) => void) | null = null
  const window = {
    addEventListener: (_: string, fn: typeof listener) => {
      listener = fn
    },
    ReactNativeWebView: { postMessage: (m: string) => sent.push(m) }
  }
  const document = { querySelector: () => frame }
  new Function('window', 'document', 'navigator', script)(window, document, {
    userActivation: activation
  })
  return {
    frame: frame.contentWindow,
    sent,
    activation,
    post: (data: unknown, source: unknown) => listener?.({ source, data })
  }
}

describe('insertIntoHead', () => {
  it('goes after <head>, else after <html>, else after the doctype, else first', () => {
    expect(insertIntoHead('<html lang="en"><head id="h"><meta></head>', 'X')).toBe(
      '<html lang="en"><head id="h">X<meta></head>'
    )
    expect(insertIntoHead('<html><body></body></html>', 'X')).toBe('<html>X<body></body></html>')
    expect(insertIntoHead('<!DOCTYPE html>\n<p>x</p>', 'X')).toBe('<!DOCTYPE html>X\n<p>x</p>')
    expect(insertIntoHead('<p>x</p>', 'X')).toBe('X<p>x</p>')
    expect(insertIntoHead('<header>not head</header>', 'X')).toBe('X<header>not head</header>')
  })
})

describe('svgPage', () => {
  it('fits an SVG with a viewBox to the width (root size dropped, as desktop does)', () => {
    const html = svgPage(
      '<svg viewBox="0 0 10 10" width="500" height="500" style="color:red"><rect/></svg>',
      theme
    )
    expect(html).toContain('<svg viewBox="0 0 10 10"><rect/></svg>')
    expect(html).toContain("script-src 'none'")
  })

  it('shows an SVG without a viewBox at its own size', () => {
    const html = svgPage('<svg width="40" height="20"><rect/></svg>', theme)
    expect(html).toContain('<svg width="40" height="20"><rect/></svg>')
  })
})

describe('mermaidPage', () => {
  it('draws a .mmd artifact filling the page, with the bundled mermaid under a nonce', () => {
    const html = mermaidPage('graph TD; A-->B', { theme, mermaidScript: 'M()' })
    const nonce = /script-src 'nonce-([A-Za-z0-9]+)'/.exec(html)?.[1]
    expect(html).toContain(`<script nonce="${nonce}">M()</script>`)
    expect(html).toContain('class="mermaid-block mermaid-fill"')
    expect(html).toContain('"theme":"default"')
    expect(html).toContain('graph TD; A--&gt;B')
  })
})
