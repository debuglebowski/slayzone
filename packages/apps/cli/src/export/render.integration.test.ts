/**
 * Real renders through a locally installed Chrome-family browser, over the same path
 * `slay tasks artifacts download --type pdf|png` takes (shared document → CDP over a
 * pipe). Skipped when this machine has no browser to find; never downloads one.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
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

/**
 * A local http server that records every request, so a test can assert the export
 * reached it — or that it never did. `/slow.png` answers after `SLOW_MS` (keeps the
 * document loading meanwhile); `/frame` is a page for a child frame.
 */
function localServer(): {
  origin: () => string
  hits: string[]
  start: () => Promise<void>
  stop: () => Promise<void>
} {
  const hits: string[] = []
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  )
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url?.startsWith('/slow.png')) {
      setTimeout(() => res.writeHead(200, { 'content-type': 'image/png' }).end(png), 2_000)
      return
    }
    if (req.url?.startsWith('/file')) {
      res
        .writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="slay-f1-attachment.txt"'
        })
        .end('pwned')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<p>remote page</p>')
  })
  return {
    hits,
    origin: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    start: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r())),
    stop: () => new Promise((r) => server.close(() => r()))
  }
}

/**
 * Review 9, F1: an html artifact (agent-written, untrusted) must not save files on the
 * machine running the export. The throwaway profile's download directory is pointed at
 * a temp dir the test watches (`downloadDir`; the export's own default is a dir inside
 * the profile, Chrome's is ~/Downloads), so whatever the browser saves lands in view.
 */
describe.skipIf(!BROWSER)('an html artifact cannot save files (review 9, F1)', () => {
  const server = localServer()
  let downloads: string
  beforeAll(() => server.start())
  afterAll(() => server.stop())
  // Removed even when a test fails: whatever an unblocked download left there.
  afterEach(() => fs.rmSync(downloads, { recursive: true, force: true }))

  /** A fresh temp dir the next export's profile downloads into. */
  function seedDownloadDir(): void {
    downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-f1-downloads-'))
  }

  /** Nothing in the seeded dir, and none of the test's file names in ~/Downloads. */
  function expectNothingSaved(): void {
    expect(fs.readdirSync(downloads)).toEqual([])
    const home = path.join(os.homedir(), 'Downloads')
    const there = fs.existsSync(home) ? fs.readdirSync(home) : []
    expect(there.filter((f) => f.startsWith('slay-f1-'))).toEqual([])
  }

  // Not a navigation: the download is denied and the export goes on, as on desktop
  // (its export session cancels every download).
  test('an <a download> click (blob: and data:) saves nothing; the PDF is produced', {
    timeout: 90_000
  }, async () => {
    seedDownloadDir()
    const html = `<!DOCTYPE html><p>report</p><script>
      for (const [href, name] of [
        [URL.createObjectURL(new Blob(['pwned'])), 'slay-f1-blob.txt'],
        ['data:text/plain,pwned', 'slay-f1-data.txt']
      ]) {
        const a = document.createElement('a'); a.href = href; a.download = name
        document.body.appendChild(a); a.click()
      }
    </script><img src="${server.origin()}/slow.png">`
    const pdf = await renderPdf(BROWSER as string, html, {
      waitReady: false,
      browser: { commandTimeoutMs: 30_000, downloadDir: downloads }
    })
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    // The slow image kept the page loading for 2 s: time for a download to land.
    await new Promise((r) => setTimeout(r, 1_000))
    expectNothingSaved()
  })

  // A navigation of the document itself (here: to a data: URL Chrome turns into a
  // download): refused, and the export fails — it never prints another page (F2).
  test('a data: navigation that would download saves nothing; the export fails clearly', {
    timeout: 90_000
  }, async () => {
    seedDownloadDir()
    const html = `<!DOCTYPE html><p>report</p><script>location.href = 'data:application/octet-stream,pwned'</script><img src="${server.origin()}/slow.png">`
    await expect(
      renderPdf(BROWSER as string, html, {
        waitReady: false,
        browser: { commandTimeoutMs: 30_000, downloadDir: downloads }
      })
    ).rejects.toThrow(/tried to navigate away/)
    await new Promise((r) => setTimeout(r, 1_000))
    expectNothingSaved()
  })
})

/**
 * Review 9, F2 (CLI part): the export document must stay the document the export
 * built. One that navigates itself (meta refresh, `location.href =`) would print
 * another page — an attacker's — and that page's scripts would run with no export
 * policy. Every such navigation is refused before anything is requested, and the
 * export fails with a clear error. Navigations within the document (fragment, history
 * API) and a child frame's own navigations stay allowed.
 */
describe.skipIf(!BROWSER)('the export document cannot navigate itself (review 9, F2)', () => {
  const server = localServer()
  beforeAll(() => server.start())
  afterAll(() => server.stop())
  const opts = {
    // The ready wait gives a navigation queued for after load (a meta refresh) time to
    // start before printing: the flag is never set, so it waits the full budget.
    waitReady: true,
    readyTimeoutMs: 5_000,
    browser: { commandTimeoutMs: 30_000 }
  }

  for (const [name, html] of [
    [
      'a meta refresh to an http URL',
      () =>
        `<!DOCTYPE html><meta http-equiv="refresh" content="0;url=${server.origin()}/meta"><p>x</p>`
    ],
    [
      "location.href = 'data:…'",
      () =>
        `<!DOCTYPE html><p>x</p><script>location.href = 'data:text/html,<p>attacker</p>'</script>`
    ],
    [
      'location.href = a local http server',
      () => `<!DOCTYPE html><p>x</p><script>location.href = '${server.origin()}/'</script>`
    ],
    [
      'location.href = a download from a local http server',
      () => `<!DOCTYPE html><p>x</p><script>location.href = '${server.origin()}/file'</script>`
    ],
    [
      'a navigation started from a timer after load',
      () =>
        `<!DOCTYPE html><p>x</p><script>addEventListener('load', () => setTimeout(() => { location.href = '${server.origin()}/late' }, 50))</script>`
    ],
    [
      'a blob: document',
      () =>
        `<!DOCTYPE html><p>x</p><script>location.href = URL.createObjectURL(new Blob(['<p>attacker</p>'], { type: 'text/html' }))</script>`
    ]
  ] as const) {
    test(`${name}: the export fails, nothing is requested`, { timeout: 90_000 }, async () => {
      server.hits.length = 0
      await expect(renderPdf(BROWSER as string, html(), opts)).rejects.toThrow(
        /The document tried to navigate away/
      )
      expect(server.hits).toEqual([])
    })
  }

  test('navigations within the document, a refresh due later, a child frame’s own: still export', {
    timeout: 90_000
  }, async () => {
    server.hits.length = 0
    // The refresh (a dashboard's) is due long after the export is done.
    const html = `<!DOCTYPE html><meta http-equiv="refresh" content="600"><p>x</p><iframe id="f" src="${server.origin()}/frame"></iframe><script>
      location.hash = '#a'; history.pushState({}, '', '#b')
      addEventListener('load', () => { document.getElementById('f').src = '${server.origin()}/frame2' })
    </script>`
    const pdf = await renderPdf(BROWSER as string, html, { ...opts, readyTimeoutMs: 3_000 })
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(server.hits).toContain('/frame')
    expect(server.hits).toContain('/frame2')
  })
})

/**
 * Review 9, L1: printable reports call `print()` on load. The export's own print is
 * the browser's printToPDF; the page's print() must not get in its way ("Page is
 * already being printed"). Desktop's sandbox makes it a no-op; so does the CLI.
 */
describe.skipIf(!BROWSER)('an html artifact that calls print() (review 9, L1)', () => {
  test('print() on load, on the load event and from a timer while printing: PDF produced', {
    timeout: 90_000
  }, async () => {
    const html = `<!DOCTYPE html><p>printable report</p><script>
      print()
      addEventListener('load', () => print())
      setInterval(() => print(), 1)
      addEventListener('beforeprint', () => print())
    </script><iframe srcdoc="<script>print()</script>"></iframe>`
    const pdf = await renderPdf(BROWSER as string, html, {
      waitReady: false,
      browser: { commandTimeoutMs: 30_000 }
    })
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  })
})
