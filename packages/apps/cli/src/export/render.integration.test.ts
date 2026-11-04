/**
 * Real renders through a locally installed Chrome-family browser, over the same path
 * `slay tasks artifacts download --type pdf|png` takes (shared document → CDP over a
 * pipe). Skipped when this machine has no browser to find; never downloads one.
 */
import { describe, expect, test } from 'vitest'
import { defaultBrowserEnv, findBrowser } from './browser'
import { defaultExportDeps, exportArtifact, type ExportDeps } from './export-artifact'

const BROWSER = findBrowser(defaultBrowserEnv())
if (!BROWSER) console.error('SKIP render.integration: no Chrome/Chromium/Edge/Brave found')

const deps: ExportDeps = {
  ...defaultExportDeps(),
  installBrowser: async () => {
    throw new Error('the integration test never downloads a browser')
  }
}

function pngSize(buf: Buffer): { w: number; h: number } {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

describe.skipIf(!BROWSER)('render in a local browser', () => {
  test('markdown → PDF', { timeout: 60_000 }, async () => {
    const pdf = await exportArtifact(
      {
        type: 'pdf',
        content: '# Report\n\nSome **bold** text.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
        mode: 'markdown',
        title: 'report.md'
      },
      deps
    )
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(1000)
    // A4 portrait in points (595.28 × 841.89).
    expect(pdf.toString('latin1')).toMatch(/MediaBox\s*\[\s*0 0 595\.\d+ 841\.\d+\s*\]/)
  })

  test('svg → PNG at 2x the drawing size', { timeout: 60_000 }, async () => {
    const png = await exportArtifact(
      {
        type: 'png',
        content:
          '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#e11"/></svg>',
        mode: 'svg-preview',
        title: 'box.svg'
      },
      deps
    )
    const { w, h } = pngSize(png)
    // Exactly the drawing at 2x: the PNG document lays the <svg> out as a block, so
    // no inline baseline gap pads the capture.
    expect(w).toBe(240)
    expect(h).toBe(160)
  })

  test('mermaid → PNG (waits for mermaid to draw)', { timeout: 90_000 }, async () => {
    const warnings: string[] = []
    const png = await exportArtifact(
      {
        type: 'png',
        content: 'graph TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Done]\n  B -->|no| A\n',
        mode: 'mermaid-preview',
        title: 'flow.mmd'
      },
      { ...deps, log: (l) => warnings.push(l) }
    )
    expect(warnings).toEqual([])
    const { w, h } = pngSize(png)
    // A drawn flowchart, not the 10×10 floor nor the 400×300 "nothing there" default.
    expect(w % 2).toBe(0)
    expect(h % 2).toBe(0)
    expect(w).toBeGreaterThan(100)
    expect(h).toBeGreaterThan(300)
    expect(w).toBeLessThan(4000)
  })

  test('mermaid → PDF', { timeout: 90_000 }, async () => {
    const pdf = await exportArtifact(
      { type: 'pdf', content: 'graph LR\n  A --> B\n', mode: 'mermaid-preview', title: 'f.mmd' },
      deps
    )
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  })
})
