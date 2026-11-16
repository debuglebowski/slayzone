import { describe, expect, test } from 'vitest'
import {
  RENDER_MODE_INFO,
  canExportAsHtml,
  canExportAsPdf,
  canExportAsPng,
  getEffectiveRenderMode,
  hasZoomableSurface,
  isBinaryRenderMode
} from './types'

describe('video render mode', () => {
  test.each(['clip.mp4', 'CLIP.MP4', 'clip.m4v', 'clip.webm', 'clip.mov'])(
    '%s is inferred as video',
    (title) => {
      expect(getEffectiveRenderMode(title, null)).toBe('video')
    }
  )

  test('is labelled Video and can be chosen as an override', () => {
    expect(RENDER_MODE_INFO.video.label).toBe('Video')
    expect(getEffectiveRenderMode('clip.bin', 'video')).toBe('video')
  })

  test('is binary: never read, searched or saved as text', () => {
    expect(isBinaryRenderMode('video')).toBe(true)
  })

  test('the player owns its surface: no header zoom, no document exports', () => {
    expect(hasZoomableSurface('video', 'preview')).toBe(false)
    expect(hasZoomableSurface('video', null)).toBe(false)
    expect(canExportAsPdf('video')).toBe(false)
    expect(canExportAsPng('video')).toBe(false)
    expect(canExportAsHtml('video')).toBe(false)
  })
})

describe('audio, diff, archive and font render modes', () => {
  test.each([
    ['voice.mp3', 'audio'],
    ['voice.wav', 'audio'],
    ['voice.m4a', 'audio'],
    ['voice.aac', 'audio'],
    ['voice.ogg', 'audio'],
    ['voice.oga', 'audio'],
    ['voice.opus', 'audio'],
    ['voice.FLAC', 'audio'],
    ['fix.diff', 'diff'],
    ['fix.patch', 'diff'],
    ['bundle.zip', 'archive'],
    ['face.ttf', 'font'],
    ['face.otf', 'font'],
    ['face.woff', 'font'],
    ['face.woff2', 'font']
  ] as const)('%s is inferred as %s', (title, mode) => {
    expect(getEffectiveRenderMode(title, null)).toBe(mode)
  })

  test('labels', () => {
    expect(RENDER_MODE_INFO.audio.label).toBe('Audio')
    expect(RENDER_MODE_INFO.diff.label).toBe('Diff')
    expect(RENDER_MODE_INFO.archive.label).toBe('Archive')
    expect(RENDER_MODE_INFO.font.label).toBe('Font')
  })

  test('audio, archives and fonts are binary; a diff is text', () => {
    expect(isBinaryRenderMode('audio')).toBe(true)
    expect(isBinaryRenderMode('archive')).toBe(true)
    expect(isBinaryRenderMode('font')).toBe(true)
    expect(isBinaryRenderMode('diff')).toBe(false)
  })

  test('the diff zooms its source pane only; its rendered view scrolls itself', () => {
    expect(hasZoomableSurface('diff', 'preview')).toBe(false)
    expect(hasZoomableSurface('diff', 'split')).toBe(true)
    expect(hasZoomableSurface('diff', 'raw')).toBe(true)
    for (const mode of ['audio', 'archive', 'font'] as const)
      expect(hasZoomableSurface(mode, 'preview')).toBe(false)
  })

  test('a diff keeps the PDF and HTML downloads it had as code', () => {
    expect(canExportAsPdf('diff')).toBe(true)
    expect(canExportAsHtml('diff')).toBe(true)
    expect(canExportAsPng('diff')).toBe(false)
    for (const mode of ['audio', 'archive', 'font'] as const) {
      expect(canExportAsPdf(mode)).toBe(false)
      expect(canExportAsHtml(mode)).toBe(false)
    }
  })

  test('subtitle files read as code, not rich text', () => {
    expect(getEffectiveRenderMode('clip.srt', null)).toBe('code')
    expect(getEffectiveRenderMode('clip.vtt', null)).toBe('code')
  })
})
