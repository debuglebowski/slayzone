import { describe, expect, it } from 'vitest'
import {
  artifactControlsPositions,
  controlsPosition,
  injectArtifactControlsRuntime,
  parseArtifactControlsSize,
  readArtifactPreviewMode,
  withArtifactPreviewMode
} from './artifact-controls'

const PAGE = `<!doctype html><html><head><title>t</title></head><body>
<main>Screen</main>
<slay-artifact-controls><button data-action="next">Next</button></slay-artifact-controls>
</body></html>`

describe('controlsPosition', () => {
  it('reads the four positions, case-insensitively', () => {
    expect(controlsPosition('top')).toBe('top')
    expect(controlsPosition(' LEFT ')).toBe('left')
    expect(controlsPosition('right')).toBe('right')
  })
  it('defaults a missing or unknown position to bottom', () => {
    expect(controlsPosition(null)).toBe('bottom')
    expect(controlsPosition('')).toBe('bottom')
    expect(controlsPosition('middle')).toBe('bottom')
  })
})

describe('artifactControlsPositions', () => {
  it('lists each position used once, in dock order', () => {
    expect(artifactControlsPositions([null, 'right', 'top', 'TOP', 'nonsense', 'left'])).toEqual([
      'top',
      'bottom',
      'left',
      'right'
    ])
  })
  it('is empty without controls', () => {
    expect(artifactControlsPositions([])).toEqual([])
  })
})

describe('preview mode URL params', () => {
  it('round-trips the screen and each controls position', () => {
    const src = 'slz-artifact://artifact-abc/hub/x/a/page.html?v=3&theme=dark'
    const screen = new URL(withArtifactPreviewMode(src, { kind: 'screen' }))
    expect(screen.searchParams.get('v')).toBe('3')
    expect(screen.searchParams.get('theme')).toBe('dark')
    expect(readArtifactPreviewMode(screen)).toEqual({ kind: 'screen' })
    const top = new URL(withArtifactPreviewMode(src, { kind: 'controls', position: 'top' }))
    expect(readArtifactPreviewMode(top)).toEqual({ kind: 'controls', position: 'top' })
  })
  it('reads no mode from a plain URL or an unknown mode', () => {
    expect(readArtifactPreviewMode(new URL('slz-file://app/Users/me/a.html'))).toBeNull()
    expect(
      readArtifactPreviewMode(new URL('slz-file://app/Users/me/a.html?slayzone-preview=nope'))
    ).toBeNull()
  })
})

describe('injectArtifactControlsRuntime', () => {
  it('injects the screen runtime into the head', () => {
    const out = injectArtifactControlsRuntime(PAGE, { kind: 'screen' })
    const head = out.slice(0, out.indexOf('</head>'))
    expect(head).toContain('id="slz-artifact-controls-style"')
    expect(head).toContain('id="slz-artifact-controls-runtime"')
    expect(out).toContain('<main>Screen</main>')
  })
  it('leaves a screen without controls untouched', () => {
    const page = '<html><head></head><body>plain</body></html>'
    expect(injectArtifactControlsRuntime(page, { kind: 'screen' })).toBe(page)
  })
  it('always injects the controls runtime, before the content when there is no head', () => {
    const out = injectArtifactControlsRuntime('<p>x</p>', { kind: 'controls', position: 'left' })
    expect(out.startsWith('<style id="slz-artifact-controls-style">')).toBe(true)
    expect(out.endsWith('<p>x</p>')).toBe(true)
    expect(out).toContain('"left"')
  })
})

describe('parseArtifactControlsSize', () => {
  it('accepts finite non-negative sizes', () => {
    expect(
      parseArtifactControlsSize({ type: 'slayzone:artifact-controls-size', width: 120, height: 40 })
    ).toEqual({ width: 120, height: 40 })
  })
  it('rejects anything else', () => {
    for (const data of [
      null,
      'x',
      { type: 'slayzone:artifact-controls-size', width: -1, height: 4 },
      { type: 'slayzone:artifact-controls-size', width: Number.NaN, height: 4 },
      { type: 'other', width: 1, height: 1 }
    ]) {
      expect(parseArtifactControlsSize(data)).toBeNull()
    }
  })
})
