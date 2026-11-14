import type { RenderMode } from '@slayzone/task-contracts/types'
import { EXPORT_FILE_TYPES, exportFileName, exportFormatsOf } from './export-formats'

const formats = (mode: RenderMode) => exportFormatsOf(mode).map((f) => f.format)

describe('exportFormatsOf: the formats desktop offers for the mode', () => {
  it.each<[RenderMode, string[]]>([
    ['markdown', ['pdf', 'html']],
    ['code', ['pdf', 'html']],
    ['html-preview', ['pdf']],
    ['svg-preview', ['pdf', 'png']],
    ['mermaid-preview', ['pdf', 'png', 'html']],
    ['image', []],
    ['pdf', []]
  ])('%s → %j', (mode, expected) => {
    expect(formats(mode)).toEqual(expected)
  })

  it('labels each format for the action sheet', () => {
    expect(exportFormatsOf('mermaid-preview').map((f) => f.label)).toEqual(['PDF', 'PNG', 'HTML'])
  })
})

describe('export files', () => {
  it('declares the type the share sheet needs for each format', () => {
    expect(EXPORT_FILE_TYPES).toEqual({
      pdf: { extension: 'pdf', mimeType: 'application/pdf', UTI: 'com.adobe.pdf' },
      png: { extension: 'png', mimeType: 'image/png', UTI: 'public.png' },
      html: { extension: 'html', mimeType: 'text/html', UTI: 'public.html' }
    })
  })

  it("names the file after the artifact's title, its extension swapped for the format's", () => {
    expect(exportFileName('plan.md', 'pdf')).toBe('plan.pdf')
    expect(exportFileName('flow.mmd', 'png')).toBe('flow.png')
    expect(exportFileName('notes', 'html')).toBe('notes.html')
  })

  it('keeps the name legal on iOS: no separators, nothing hidden', () => {
    expect(exportFileName('a/b:c.md', 'pdf')).toBe('a_b_c.pdf')
    expect(exportFileName('.env', 'html')).toBe('_env.html')
  })
})

// Review 4, M5: the format's extension always survives, and the name fits the
// filesystem's 255-byte limit whatever the title.
describe('export file names from awkward titles', () => {
  it('a title of only dots, or one that climbs, still gets a name and its extension', () => {
    expect(exportFileName('...', 'pdf')).toMatch(/\.pdf$/)
    expect(exportFileName('...', 'pdf')).not.toBe('_pdf')
    expect(exportFileName('../x', 'pdf')).toBe('x.pdf')
    expect(exportFileName('..', 'html')).toMatch(/^[^.].*\.html$/)
  })
  it('a title over 255 bytes is cut (never mid-character) to fit, extension kept', () => {
    const name = exportFileName(`${'é'.repeat(200)}.md`, 'pdf')
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255)
    expect(name.endsWith('.pdf')).toBe(true)
    expect(name).not.toContain('\uFFFD')
  })
})
