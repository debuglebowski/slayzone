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
