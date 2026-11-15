/**
 * Real renders through a locally installed Chrome-family browser, over the same path
 * `slay tasks artifacts download --type pdf|png` takes (shared document → CDP over a
 * pipe). Skipped when this machine has no browser to find; never downloads one.
 */
import { describe, expect, test } from 'vitest'
import { defaultBrowserEnv, findBrowser } from './browser'
import { buildDocumentHtml } from '@slayzone/task-artifacts/export-html'
import { launchBrowser } from './cdp'
import { defaultExportDeps, exportArtifact, type ExportDeps } from './export-artifact'
import { renderPdf, renderPng } from './render'

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
  // Review 4, C1: a large document prints although printing takes far longer than
  // the per-command deadline (cut to 1 s here), and its PDF streams back in pieces.
  test('a 15,000-line code artifact → PDF (no fixed print deadline)', {
    timeout: 180_000
  }, async () => {
    const code = Array.from(
      { length: 15_000 },
      (_, i) => `const line${i} = ${i} // ${'x'.repeat(40)}`
    ).join('\n')
    const started = Date.now()
    const pdf = await renderPdf(BROWSER as string, buildDocumentHtml(code, 'code', 'big.ts'), {
      waitReady: false,
      browser: { commandTimeoutMs: 1_000 }
    })
    expect(Date.now() - started).toBeGreaterThan(1_000)
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    // Hundreds of A4 pages.
    expect((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length).toBeGreaterThan(200)
  })

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

describe.skipIf(!BROWSER)('a page that crashes mid-render (review 5, #2)', () => {
  // The renderer dies while a long command runs; the browser process keeps answering
  // its liveness check. The command must fail at once, not wait forever.
  test('a long command on a crashed page rejects within seconds', { timeout: 60_000 }, async () => {
    // A liveness interval far beyond the test: only the crash itself can end it.
    const b = await launchBrowser(BROWSER as string, { livenessIntervalMs: 120_000 })
    try {
      await b.send('Target.setDiscoverTargets', { discover: true })
      const { targetId } = await b.send<{ targetId: string }>('Target.createTarget', {
        url: 'about:blank'
      })
      const { sessionId } = await b.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId,
        flatten: true
      })
      await b.send('Inspector.enable', {}, sessionId)
      const long = b.sendLong(
        'Runtime.evaluate',
        { expression: 'new Promise(() => {})', awaitPromise: true },
        sessionId
      )
      const outcome = long.then(
        () => 'resolved',
        (err: Error) => err.message
      )
      const started = Date.now()
      // Page.crash itself is never answered: the renderer is gone.
      b.send('Page.crash', {}, sessionId).catch(() => undefined)
      expect(await outcome).toMatch(/page (crashed|closed) while rendering/)
      expect(Date.now() - started).toBeLessThan(10_000)
    } finally {
      await b.close()
    }
  })
})

describe.skipIf(!BROWSER)('an html artifact that opens JS dialogs (review 6, #2)', () => {
  // alert/confirm/prompt block the page until answered: unanswered, the document
  // never finishes loading and the export waits out the command deadline.
  test('alert/confirm/prompt are dismissed and the PDF is produced', {
    timeout: 60_000
  }, async () => {
    const html =
      "<!DOCTYPE html><script>alert('hi');document.title=String(confirm('x'))+'|'+String(prompt('y'))</script><p>done</p>"
    const pdf = await renderPdf(BROWSER as string, html, {
      waitReady: false,
      // A dialog left open blocks the page until this deadline fails the render (no
      // wall-clock bound asserted: render time on a loaded box varies too much).
      browser: { commandTimeoutMs: 15_000 }
    })
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  })

  test('a dialog opened after load (timer) does not stall the PNG', {
    timeout: 60_000
  }, async () => {
    const html =
      "<!DOCTYPE html><body style='margin:0'><div style='width:50px;height:40px;background:red'></div><script>setTimeout(() => alert('late'), 0)</script></body>"
    const png = await renderPng(BROWSER as string, html, {
      waitReady: false,
      browser: { commandTimeoutMs: 15_000 }
    })
    expect(pngSize(png).w).toBeGreaterThan(0)
  })
})

describe.skipIf(!BROWSER)('a script that loops once printing starts (review 7, #3)', () => {
  // The page's renderer spins while the browser process keeps answering: only a probe
  // of the page itself can tell. Unanswered for `stallMs`, the export fails (and the
  // browser goes with it) instead of waiting forever.
  // (A loop armed for later — `setTimeout` from beforeprint — is not a hang: the print
  // is laid out synchronously right after the event, before any timer runs.)
  test('a beforeprint handler that never yields fails the PDF with a clear error', {
    timeout: 120_000
  }, async () => {
    const html =
      "<!DOCTYPE html><p>x</p><script>addEventListener('beforeprint', () => { for (;;) {} })</script>"
    await expect(
      renderPdf(BROWSER as string, html, {
        waitReady: false,
        browser: { commandTimeoutMs: 30_000, stallMs: 3_000 }
      })
    ).rejects.toThrow(/page stopped responding/)
  })
})
