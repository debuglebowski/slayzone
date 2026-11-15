import { describe, expect, it } from 'vitest'
import { contentTypeForPath } from './mime-types'

describe('contentTypeForPath', () => {
  it('maps the preview types by extension, case-insensitively', () => {
    expect(contentTypeForPath('docs/index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeForPath('a/b/Photo.JPG')).toBe('image/jpeg')
    expect(contentTypeForPath('report.pdf')).toBe('application/pdf')
    expect(contentTypeForPath('fonts/x.woff2')).toBe('font/woff2')
    expect(contentTypeForPath('icon.svg')).toBe('image/svg+xml')
    expect(contentTypeForPath('clip.mp4')).toBe('video/mp4')
    expect(contentTypeForPath('C:\\work\\notes.txt')).toBe('text/plain; charset=utf-8')
  })

  it('falls back to application/octet-stream for unknown or missing extensions', () => {
    expect(contentTypeForPath('Makefile')).toBe('application/octet-stream')
    expect(contentTypeForPath('archive.xyz')).toBe('application/octet-stream')
    expect(contentTypeForPath('.env')).toBe('application/octet-stream')
  })
})
