import { pageAtZoom } from './page-zoom'

const doc = {
  kind: 'document' as const,
  html: '<!doctype html><html><head><style>a{}</style></head><body>x</body></html>',
  scripts: false
}
const report = {
  kind: 'report' as const,
  html: '<!doctype html><html><head><style>iframe{}</style></head><body><iframe srcdoc="&lt;/head&gt;"></iframe></body></html>',
  token: 't'
}

describe('pageAtZoom', () => {
  it('100%: the page as it is', () => {
    expect(pageAtZoom(doc, 100)).toBe(doc)
    expect(pageAtZoom(report, 100)).toBe(report)
  })

  it('a document: CSS zoom on the root, after the page style (it reflows, as desktop)', () => {
    const zoomed = pageAtZoom(doc, 125)
    expect(zoomed).toEqual({ ...doc, html: expect.any(String) })
    expect(zoomed.kind === 'document' && zoomed.html).toBe(
      '<!doctype html><html><head><style>a{}</style><style>html{zoom:1.25}</style></head><body>x</body></html>'
    )
  })

  it("a report: its frame's viewport shrunk by the zoom and scaled back up (desktop's frame zoom)", () => {
    const zoomed = pageAtZoom(report, 200)
    expect(zoomed.kind).toBe('report')
    const html = zoomed.kind === 'report' ? zoomed.html : ''
    expect(html).toContain(
      '<style>html,body{overflow:hidden}iframe{width:50%;height:50%;transform:scale(2);transform-origin:0 0}</style></head>'
    )
    // Into the host's head, never the report's.
    expect(html.indexOf('transform:scale(2)')).toBeLessThan(html.indexOf('<body>'))
    expect(zoomed.kind === 'report' && zoomed.token).toBe('t')
  })

  it('a file (PDF): untouched; WebKit zooms it itself', () => {
    const file = { kind: 'file' as const, fileUri: 'file:///a.pdf' }
    expect(pageAtZoom(file, 150)).toBe(file)
  })
})
