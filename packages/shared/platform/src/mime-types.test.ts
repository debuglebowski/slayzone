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

  it('names every audio, video, font and subtitle type an artifact viewer plays', () => {
    expect(contentTypeForPath('clip.mov')).toBe('video/quicktime')
    expect(contentTypeForPath('clip.m4v')).toBe('video/mp4')
    expect(contentTypeForPath('voice.m4a')).toBe('audio/mp4')
    expect(contentTypeForPath('voice.aac')).toBe('audio/aac')
    expect(contentTypeForPath('voice.ogg')).toBe('audio/ogg')
    expect(contentTypeForPath('voice.oga')).toBe('audio/ogg')
    expect(contentTypeForPath('voice.opus')).toBe('audio/ogg')
    expect(contentTypeForPath('voice.flac')).toBe('audio/flac')
    expect(contentTypeForPath('font.otf')).toBe('font/otf')
    expect(contentTypeForPath('clip.vtt')).toBe('text/vtt; charset=utf-8')
  })

  it('falls back to application/octet-stream for unknown or missing extensions', () => {
    expect(contentTypeForPath('Makefile')).toBe('application/octet-stream')
    expect(contentTypeForPath('archive.xyz')).toBe('application/octet-stream')
    expect(contentTypeForPath('.env')).toBe('application/octet-stream')
  })
})
