import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { chromium, test, expect, type Browser, type Page } from '@playwright/test'
import { unzipSync } from 'fflate'

/**
 * Artifact export in the web shell, against a REAL standalone hub — the case that used
 * to answer 501 (no Electron next to the hub to render on). Export now renders in the
 * person's own browser, so the hub only serves the page.
 *
 * What only a real browser + the real hub can prove: the shell's exporter works under
 * the hub's Content-Security-Policy (a `srcdoc` frame inherits `script-src 'self'`, so
 * nothing may depend on inline script), the mermaid chunk loads from the real bundle,
 * and an artifact's own script never runs with the shell's origin. A PDF prints in the
 * hub's export frame (`/export-frame`, its own sandboxing policy): there an artifact
 * renders as written — its scripts run, remote images load — on an opaque origin that
 * reaches nothing of the shell's. The frame reports to the shell by postMessage; the
 * tests read those reports.
 *
 * The page is the login screen: `window.api` (and so the exporter) is installed before
 * sign-in, and the exporter needs nothing from a session — the client has already read
 * the content when it calls it.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const HUB_DIR = path.resolve(__dirname, '..', '..', '..', 'hub')
const HUB_BIN = path.join(HUB_DIR, 'dist', 'bin.cjs')
const WEB_INDEX = path.join(HUB_DIR, 'dist', 'web', 'index.html')

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

/** No inherited SLAYZONE_/ELECTRON_ wiring reaches the hub (same guard as 113). */
function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue
    if (/^(ELECTRON_|SLAYZONE_)/.test(k)) continue
    out[k] = v
  }
  return out
}

async function waitForHubHealth(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000)
      })
      if (res.status === 200 && ((await res.json()) as { ok?: boolean } | null)?.ok) return
    } catch {
      /* listener not up yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`hub /health not ready on :${port} within ${timeoutMs}ms`)
}

interface Hub {
  port: number
  root: string
  stop: () => Promise<void>
}

async function spawnHub(): Promise<Hub> {
  if (!fs.existsSync(HUB_BIN)) throw new Error(`hub bin missing: ${HUB_BIN} (run pnpm build)`)
  if (!fs.existsSync(WEB_INDEX)) {
    throw new Error(`web shell bundle missing: ${WEB_INDEX} (run pnpm build)`)
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-web-export-e2e-'))
  const port = await freePort()
  const electronPath = require('electron') as unknown as string
  const proc: ChildProcess = spawn(electronPath, [HUB_BIN], {
    env: {
      ...scrubbedEnv(),
      ELECTRON_RUN_AS_NODE: '1',
      SLAYZONE_ROOT: root,
      SLAYZONE_HUB_LISTEN_ADDRESS: `127.0.0.1:${port}`,
      SLAYZONE_HUB_REQUIRE_LOGIN: '1'
    },
    stdio: ['ignore', 'ignore', 'ignore']
  })
  const stop = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      const t = setTimeout(() => proc.kill('SIGKILL'), 3_000)
      proc.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      proc.kill('SIGTERM')
    })
  try {
    await waitForHubHealth(port)
    return { port, root, stop }
  } catch (err) {
    await stop()
    throw err
  }
}

/**
 * A remote "phishing" page an artifact navigates the export frame to: it raises a
 * password prompt and tries to print itself, reporting what it got.
 */
async function servePhish(): Promise<{
  url: string
  hits: () => number
  close: () => Promise<void>
}> {
  let hits = 0
  const srv = http.createServer((_req, res) => {
    hits++
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    res.end(
      `<!doctype html><title>Sign in</title><p>Session expired</p><script>
        addEventListener('beforeprint', function () { parent.postMessage({ probe: 'phish-printed' }, '*') })
        var answer = prompt('Session expired. Password?')
        parent.postMessage({ probe: 'phish-ran', answer: String(answer) }, '*')
        try { print() } catch (e) {}
      </script>`
    )
  })
  const port = await freePort()
  await new Promise<void>((resolve) => srv.listen(port, '127.0.0.1', () => resolve()))
  return {
    url: `http://127.0.0.1:${port}/login`,
    hits: () => hits,
    close: () => new Promise((resolve) => srv.close(() => resolve()))
  }
}

/** A plain http server on its own port: another origin than the hub's. */
async function serveImage(): Promise<{
  url: string
  hits: () => number
  close: () => Promise<void>
}> {
  // 1x1 PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  let hits = 0
  const srv = http.createServer((_req, res) => {
    hits++
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
    res.end(png)
  })
  const port = await freePort()
  await new Promise<void>((resolve) => srv.listen(port, '127.0.0.1', () => resolve()))
  return {
    url: `http://127.0.0.1:${port}/chart.png`,
    hits: () => hits,
    close: () => new Promise((resolve) => srv.close(() => resolve()))
  }
}

/** Every message the shell's window received (the export frame's reports, a probe's). */
type Received = { origin: string; data: Record<string, unknown> }
const received = (page: Page): Promise<Received[]> =>
  page.evaluate(() => (window as unknown as { __received: Received[] }).__received)
/** The export frame's last `ready` report. */
const lastReady = async (page: Page) =>
  (await received(page)).filter((m) => m.data?.state === 'ready').at(-1)?.data

type ExportRequest = {
  format: 'pdf' | 'png' | 'html'
  content: string
  mode: string
  title: string
}

/** Call the shell's exporter the way the shared client does (`electronBootstrap.exportArtifact`). */
const exportInPage = (page: Page, req: ExportRequest) =>
  page.evaluate(
    (r) =>
      (
        window as unknown as {
          api: { app: { exportArtifact: (req: unknown) => Promise<unknown> } }
        }
      ).api.app.exportArtifact(r),
    req
  )

test.describe('web shell — artifact export renders in the browser', () => {
  let hub: Hub
  let browser: Browser
  let page: Page
  const cspErrors: string[] = []

  test.beforeAll(async () => {
    hub = await spawnHub()
    browser = await chromium.launch()
    const context = await browser.newContext({ acceptDownloads: true })
    page = await context.newPage()
    page.on('console', (m) => {
      if (/Content Security Policy|Refused to/.test(m.text())) cspErrors.push(m.text())
    })
    await page.goto(`http://127.0.0.1:${hub.port}/`)
    await expect(page.getByTestId('web-login-screen')).toBeVisible({ timeout: 15_000 })
    await page.evaluate(() => {
      const w = window as unknown as { __received: unknown[] }
      w.__received = []
      window.addEventListener('message', (e) =>
        w.__received.push({ origin: e.origin, data: e.data })
      )
      // Something of the shell's an artifact must never read.
      localStorage.setItem('slz-e2e-secret', 'shell-only')
    })
  })

  test.afterAll(async () => {
    await browser?.close()
    await hub?.stop()
    if (hub) fs.rmSync(hub.root, { recursive: true, force: true })
  })

  test.afterEach(() => {
    expect(cspErrors, 'no CSP refusals').toEqual([])
  })

  test('markdown → HTML download', async () => {
    const download = page.waitForEvent('download')
    const res = await exportInPage(page, {
      format: 'html',
      mode: 'markdown',
      title: 'report.md',
      content: '# Heading\n\nSome **bold** text.'
    })
    expect(res).toEqual({ ok: true })
    const d = await download
    expect(d.suggestedFilename()).toBe('report.html')
    const html = fs.readFileSync(await d.path(), 'utf-8')
    expect(html).toContain('<strong>bold</strong>')
  })

  test('mermaid → HTML inlines the mermaid build served by the hub', async () => {
    const download = page.waitForEvent('download')
    const res = await exportInPage(page, {
      format: 'html',
      mode: 'mermaid-preview',
      title: 'diagram.mmd',
      content: 'graph TD\n  A[Start] --> B[End]\n'
    })
    expect(res).toEqual({ ok: true })
    const html = fs.readFileSync(await (await download).path(), 'utf-8')
    expect(html).toContain('<pre class="mermaid">')
    expect(html.length).toBeGreaterThan(1_000_000)
  })

  test('mermaid → PNG, drawn by the shell and rasterised at 2x', async () => {
    const download = page.waitForEvent('download')
    const res = await exportInPage(page, {
      format: 'png',
      mode: 'mermaid-preview',
      title: 'diagram.mmd',
      content: 'graph TD\n  A[Start] --> B[End]\n'
    })
    expect(res).toEqual({ ok: true })
    const d = await download
    expect(d.suggestedFilename()).toBe('diagram.png')
    const bytes = fs.readFileSync(await d.path())
    expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
    // IHDR width: a drawn diagram, not the 10px floor.
    expect(bytes.readUInt32BE(16)).toBeGreaterThan(100)
  })

  test("an artifact's own script never runs with the shell's origin", async () => {
    const download = page.waitForEvent('download')
    const res = await exportInPage(page, {
      format: 'png',
      mode: 'svg-preview',
      title: 'evil.svg',
      content:
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="parent.__pwned=1">' +
        '<script>parent.__pwned=1</script><rect width="40" height="40"/></svg>'
    })
    expect(res).toEqual({ ok: true })
    await download
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBe(
      undefined
    )
  })

  test('downloads stream in pieces: a file as itself, a folder zipped by the worker', async () => {
    // Drives the streaming save target the way the shared client does, piece by piece.
    const stream = (
      request: unknown,
      writes: Array<{ path: string; bytes: number[]; size?: number }>,
      dirs: string[] = []
    ) =>
      page.evaluate(
        async ({ request, writes, dirs }) => {
          const app = (
            window as unknown as {
              api: {
                app: {
                  saveTargetOpen: (r: unknown) => Promise<{ ok: boolean; targetId?: string }>
                  saveTargetWrite: (
                    id: string,
                    p: string,
                    d: Uint8Array,
                    size?: number
                  ) => Promise<void>
                  saveTargetMkdir: (id: string, p: string) => Promise<void>
                  saveTargetClose: (id: string) => Promise<unknown>
                }
              }
            }
          ).api.app
          const opened = await app.saveTargetOpen(request)
          if (!opened.ok || !opened.targetId) return opened
          for (const d of dirs) await app.saveTargetMkdir(opened.targetId, d)
          // Each write declares its file's total size, as the shared client does.
          const totals = new Map<string, number>()
          for (const w of writes) totals.set(w.path, (totals.get(w.path) ?? 0) + w.bytes.length)
          for (const w of writes)
            await app.saveTargetWrite(
              opened.targetId,
              w.path,
              new Uint8Array(w.bytes),
              w.size ?? totals.get(w.path)
            )
          return app.saveTargetClose(opened.targetId)
        },
        { request, writes, dirs }
      )

    const file = page.waitForEvent('download')
    expect(
      await stream({ kind: 'file', fileName: 'pic.bin', title: 'Download Artifact' }, [
        { path: '', bytes: [0, 1] },
        { path: '', bytes: [254, 255] }
      ])
    ).toEqual({ ok: true })
    const f = await file
    expect(f.suggestedFilename()).toBe('pic.bin')
    expect(Array.from(fs.readFileSync(await f.path()))).toEqual([0, 1, 254, 255])

    // The zip is built in a module worker loaded from the hub's own origin: proves the
    // worker runs under the hub's CSP (worker-src falls back to script-src 'self').
    const big = Array.from({ length: 300_000 }, (_, i) => (i * 7) & 255)
    const folder = page.waitForEvent('download')
    expect(
      await stream(
        { kind: 'directory', folderName: 'docs', title: 'Download Folder To' },
        [
          { path: 'docs/a.md', bytes: Array.from(new TextEncoder().encode('A')) },
          { path: 'docs/big.bin', bytes: big.slice(0, 150_000) },
          { path: 'docs/big.bin', bytes: big.slice(150_000) }
        ],
        ['docs/empty']
      )
    ).toEqual({ ok: true })
    const z = await folder
    expect(z.suggestedFilename()).toBe('docs.zip')
    const zip = fs.readFileSync(await z.path())
    expect(zip.subarray(0, 2).toString('latin1')).toBe('PK')
    const entries = unzipSync(new Uint8Array(zip))
    expect(new TextDecoder().decode(entries['docs/a.md'])).toBe('A')
    expect(Array.from(entries['docs/big.bin'])).toEqual(big)
    expect(Object.keys(entries)).toContain('docs/empty/')

    // Review 9, F3: the declared size reaches the worker's encoder. A file declared at
    // 4 GiB or more is zip64 from its local header on (a zip64 extra there, a 24-byte
    // descriptor), and the entry after it still reads back.
    const wide = page.waitForEvent('download')
    expect(
      await stream({ kind: 'directory', folderName: 'big', title: 'Download Folder To' }, [
        { path: 'big/huge.bin', bytes: [1, 2, 3], size: 2 ** 32 + 5 },
        { path: 'big/after.md', bytes: Array.from(new TextEncoder().encode('after')) }
      ])
    ).toEqual({ ok: true })
    const wideZip = fs.readFileSync(await (await wide).path())
    const nameLen = wideZip.readUInt16LE(26)
    expect(wideZip.subarray(30, 30 + nameLen).toString()).toBe('big/huge.bin')
    expect(wideZip.readUInt16LE(4), 'version needed').toBe(45)
    expect(wideZip.readUInt16LE(28), 'zip64 extra in the local header').toBe(20)
    expect(wideZip.readUInt16LE(30 + nameLen), 'zip64 extra id').toBe(1)
    const back = unzipSync(new Uint8Array(wideZip))
    expect(Array.from(back['big/huge.bin'])).toEqual([1, 2, 3])
    expect(new TextDecoder().decode(back['big/after.md'])).toBe('after')
  })

  test('PDF goes to the browser print dialog', async () => {
    // Headless Chromium returns from print() at once; the frame must have been laid
    // out and printed without error.
    const res = await exportInPage(page, {
      format: 'pdf',
      mode: 'markdown',
      title: 'report.md',
      content: '# Heading'
    })
    expect(res).toEqual({ ok: true })
  })

  // Review 5, #3: mermaid takes frontmatter only at the very start of the source.
  test('mermaid with frontmatter → PNG', async () => {
    const download = page.waitForEvent('download')
    const res = await exportInPage(page, {
      format: 'png',
      mode: 'mermaid-preview',
      title: 'titled.mmd',
      content: '---\ntitle: Flow\nconfig:\n  theme: forest\n---\ngraph TD\n  A[Start] --> B[End]\n'
    })
    expect(res).toEqual({ ok: true })
    const bytes = fs.readFileSync(await (await download).path())
    expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
    expect(bytes.readUInt32BE(16)).toBeGreaterThan(100)
  })

  // Review 5, #4: an html report's own scripts run when it is printed (as on desktop),
  // in the export frame, on an opaque origin that holds nothing of the shell's.
  test("html → PDF: the artifact's script runs in the export frame, not with the shell's origin", async () => {
    const probe = `<!doctype html><html><body><p id="out">pending</p><script>
      function attempt(f) { try { return String(f()) } catch (e) { return e.name } }
      document.getElementById('out').textContent = 'drawn by script'
      parent.postMessage({
        probe: 'html-artifact',
        selfOrigin: self.origin,
        storage: attempt(function () { return localStorage.getItem('slz-e2e-secret') }),
        parentStorage: attempt(function () { return parent.localStorage.getItem('slz-e2e-secret') }),
        parentDocument: attempt(function () { return parent.document.title }),
        cookie: attempt(function () { return document.cookie }),
        text: document.getElementById('out').textContent
      }, '*')
      try { parent.__pwned = 1 } catch (e) {}
    </script></body></html>`
    const res = await exportInPage(page, {
      format: 'pdf',
      mode: 'html-preview',
      title: 'report.html',
      content: probe
    })
    expect(res).toEqual({ ok: true })
    const report = (await received(page)).find((m) => m.data?.probe === 'html-artifact')
    expect(report, 'the artifact script ran').toBeTruthy()
    expect(report?.origin, 'posted from an opaque origin').toBe('null')
    expect(report?.data).toEqual({
      probe: 'html-artifact',
      selfOrigin: 'null',
      storage: 'SecurityError',
      parentStorage: 'SecurityError',
      parentDocument: 'SecurityError',
      cookie: 'SecurityError',
      text: 'drawn by script'
    })
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBe(
      undefined
    )
    expect(await lastReady(page)).toMatchObject({ settled: true })
  })

  // Review 8, L4: the export frame keeps `allow-modals` (print() needs it), so an html
  // artifact could raise a native dialog over the shell during Export PDF (a fake
  // "password?" prompt). The frame's own alert/confirm/prompt are no-ops. Known gap,
  // not asserted: a cross-origin child the artifact creates (srcdoc, javascript:, data:,
  // remote) inherits `allow-modals` and can still raise one (export-frame.ts).
  test('html → PDF: the artifact cannot raise alert/confirm/prompt, and still prints', async () => {
    const probe = `<!doctype html><html><body><p>report</p><script>
      var calls = []
      function attempt(name, f) { try { calls.push(name + ':' + String(f())) } catch (e) { calls.push(name + ':' + e.name) } }
      attempt('alert', function () { return alert('direct') })
      attempt('confirm', function () { return confirm('Continue?') })
      attempt('prompt', function () { return prompt('Session expired - password?') })
      try { delete window.alert } catch (e) {}
      attempt('alert-after-delete', function () { return alert('after delete') })
      attempt('redefine', function () { Object.defineProperty(window, 'prompt', { value: function () { return 'x' } }); return 'redefined' })
      attempt('prompt-after-redefine', function () { return prompt('after redefine') })
      var child = document.createElement('iframe')
      document.body.appendChild(child)
      attempt('child-prompt', function () { return child.contentWindow.prompt('from child') })
      setTimeout(function () {
        attempt('timer-prompt', function () { return prompt('from a timer') })
        parent.postMessage({ probe: 'dialogs', calls: calls }, '*')
      }, 0)
    </script></body></html>`
    const dialogs: string[] = []
    const onDialog = (d: import('@playwright/test').Dialog): void => {
      dialogs.push(`${d.type()}: ${d.message()}`)
      void d.dismiss().catch(() => {})
    }
    page.on('dialog', onDialog)
    try {
      const res = await exportInPage(page, {
        format: 'pdf',
        mode: 'html-preview',
        title: 'phish.html',
        content: probe
      })
      expect(res, 'printed').toEqual({ ok: true })
      expect(dialogs, 'no dialog reached the page').toEqual([])
      const report = (await received(page)).find((m) => m.data?.probe === 'dialogs')
      expect(report?.data.calls, 'every call ran, and each was a no-op').toEqual([
        'alert:undefined',
        'confirm:false',
        'prompt:null',
        'alert-after-delete:undefined',
        'redefine:TypeError',
        'prompt-after-redefine:null',
        // Chromium gives a sandboxed document's about:blank child a fresh opaque origin.
        'child-prompt:SecurityError',
        'timer-prompt:null'
      ])
      expect(await lastReady(page)).toMatchObject({ settled: true })
    } finally {
      page.off('dialog', onDialog)
    }
  })

  // Review 9, F2: the export frame can be navigated to a new document (meta refresh,
  // location.href to http: or data:). That document is a fresh window WITHOUT the
  // bootstrap's dialog lock; with the shell's `allow-modals` it could raise a password
  // prompt over the shell, and its own print() would print the attacker's page. The
  // shell drops `allow-modals` from the frame for any next document, and treats a
  // document load its export frame does not vouch for as hostile: frame removed at
  // once, export failed, nothing printed.
  const NAVIGATED =
    'The artifact tried to load another page while it was being exported, so nothing was printed.'
  const navigations: Array<[string, (phish: string) => string]> = [
    [
      'meta refresh to an http page',
      (phish) =>
        `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${phish}"></head>` +
        '<body><p>report</p></body></html>'
    ],
    [
      'location.href to a data: page',
      () =>
        '<!doctype html><html><body><p>report</p><script>' +
        'location.href = "data:text/html,<script>prompt(1)<\\/script>"' +
        '</script></body></html>'
    ],
    [
      'location.href to an http page',
      (phish) =>
        `<!doctype html><html><body><p>report</p><script>location.href = ${JSON.stringify(phish)}</script></body></html>`
    ],
    [
      'location.href after load (an export already rendering)',
      (phish) =>
        '<!doctype html><html><body><p>report</p><script>' +
        `addEventListener('load', function () { location.href = ${JSON.stringify(phish)} })` +
        '</script></body></html>'
    ],
    [
      // Not governed by the shell's frame-src: the frame becomes a blank window.
      'location.href to about:blank',
      () =>
        '<!doctype html><html><body><p>report</p><script>location.href = "about:blank"</script></body></html>'
    ],
    [
      // The hub's own pages are the only ones the shell's frame-src lets in.
      'location.href to a fresh export frame',
      () =>
        '<!doctype html><html><body><p>report</p><script>location.href = "/export-frame"</script></body></html>'
    ],
    [
      // The document erases the bootstrap's navigation watch (document.open) and blocks
      // it (its own capture listeners first) before navigating: the shell still sees a
      // frame load its bootstrap never vouches for.
      'a navigation the bootstrap cannot see',
      () =>
        '<!doctype html><html><body><p>report</p><script>' +
        "addEventListener('load', function () {" +
        "document.open(); document.write('<p>rewritten</p>'); document.close();" +
        'function stop(e) { e.stopImmediatePropagation() }' +
        "addEventListener('beforeunload', stop, true); addEventListener('pagehide', stop, true);" +
        "location.href = 'about:blank'" +
        '})' +
        '</script></body></html>'
    ]
  ]
  for (const [name, artifact] of navigations) {
    test(`html → PDF: ${name} fails the export, raises no dialog, prints nothing`, async () => {
      const phish = await servePhish()
      const dialogs: string[] = []
      const onDialog = (d: import('@playwright/test').Dialog): void => {
        dialogs.push(`${d.type()}: ${d.message()}`)
        void d.dismiss().catch(() => {})
      }
      page.on('dialog', onDialog)
      try {
        const before = (await received(page)).length
        const res = await exportInPage(page, {
          format: 'pdf',
          mode: 'html-preview',
          title: 'phish.html',
          content: artifact(phish.url)
        })
        expect(res, 'failed with the clear error').toEqual({ ok: false, error: NAVIGATED })
        // Whatever the next document still does after the frame is gone.
        await page.waitForTimeout(1_000)
        // The shell's own frame-src refuses http: and data: documents in its frames
        // (a layer of its own); the guard holds without it, so the refusal may or may
        // not be reached before the frame is gone.
        for (let i = cspErrors.length - 1; i >= 0; i--) {
          if (
            /^Framing '[^']*' violates the following Content Security Policy directive: "default-src 'self'"/.test(
              cspErrors[i]
            )
          )
            cspErrors.splice(i, 1)
        }
        expect(dialogs, 'no dialog reached the page').toEqual([])
        const after = (await received(page)).slice(before)
        expect(
          after.filter((m) => m.data?.state === 'ready'),
          'the bootstrap never printed'
        ).toEqual([])
        expect(
          after.filter((m) => m.data?.probe === 'phish-printed'),
          'the next page never printed'
        ).toEqual([])
        expect(await page.locator('iframe').count(), 'the frame is gone').toBe(0)
      } finally {
        page.off('dialog', onDialog)
        await phish.close()
      }
    })
  }

  // A javascript: URL that returns markup would replace the document with one in a fresh
  // window. Chromium does not navigate a sandboxed frame there (the document prints);
  // either way no dialog reaches the shell.
  test('html → PDF: a javascript: URL navigation raises no dialog', async () => {
    const dialogs: string[] = []
    const onDialog = (d: import('@playwright/test').Dialog): void => {
      dialogs.push(`${d.type()}: ${d.message()}`)
      void d.dismiss().catch(() => {})
    }
    page.on('dialog', onDialog)
    try {
      const res = await exportInPage(page, {
        format: 'pdf',
        mode: 'html-preview',
        title: 'js.html',
        content:
          '<!doctype html><html><body><p>report</p><script>' +
          `location.href = 'javascript:"<script>prompt(\\'Session expired. Password?\\')<\\/script>"'` +
          '</script></body></html>'
      })
      expect([{ ok: true }, { ok: false, error: NAVIGATED }]).toContainEqual(res)
      await page.waitForTimeout(1_000)
      expect(dialogs, 'no dialog reached the page').toEqual([])
    } finally {
      page.off('dialog', onDialog)
    }
  })

  // Not a navigation: the document rewriting itself (document.open/write/close after
  // load, a fragment change) loads the frame again but stays the bootstrap's realm.
  test('html → PDF: a document that rewrites itself and changes its fragment still prints', async () => {
    const res = await exportInPage(page, {
      format: 'pdf',
      mode: 'html-preview',
      title: 'rewrite.html',
      content:
        '<!doctype html><html><body><p>first</p><script>' +
        "addEventListener('load', function () { setTimeout(function () {" +
        'document.open(); document.write(\'<p>rewritten</p><script>location.hash = "#end"<\\/script>\'); document.close()' +
        '}, 0) })' +
        '</script></body></html>'
    })
    expect(res).toEqual({ ok: true })
    expect(await lastReady(page)).toMatchObject({ settled: true })
  })

  // Review 5, #8: markdown's remote images print (another origin than the hub's).
  test('markdown → PDF with a remote image: the image loads in the export frame', async () => {
    const image = await serveImage()
    try {
      const res = await exportInPage(page, {
        format: 'pdf',
        mode: 'markdown',
        title: 'chart.md',
        content: `# Chart\n\n![chart](${image.url})\n`
      })
      expect(res).toEqual({ ok: true })
      expect(await lastReady(page)).toMatchObject({
        settled: true,
        images: { total: 1, loaded: 1 }
      })
      expect(image.hits(), 'fetched from its own origin').toBeGreaterThan(0)
    } finally {
      await image.close()
    }
  })

  test('mermaid → PDF: drawn in the export frame by the inlined build', async () => {
    const res = await exportInPage(page, {
      format: 'pdf',
      mode: 'mermaid-preview',
      title: 'titled.mmd',
      content: '---\ntitle: Flow\n---\ngraph TD\n  A[Start] --> B[End]\n'
    })
    expect(res).toEqual({ ok: true })
    expect(await lastReady(page)).toMatchObject({ settled: true, drawn: true })
  })

  // Review 5, #15: the HTML file, opened later on its own, draws its diagram.
  test('mermaid → HTML file draws itself when opened', async () => {
    const download = page.waitForEvent('download')
    const res = await exportInPage(page, {
      format: 'html',
      mode: 'mermaid-preview',
      title: 'diagram.mmd',
      content: '---\ntitle: Flow\n---\ngraph TD\n  A[Start] --> B[End]\n'
    })
    expect(res).toEqual({ ok: true })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-web-export-html-'))
    const opened = await page.context().newPage()
    try {
      const file = path.join(dir, 'diagram.html')
      await (await download).saveAs(file)
      await opened.goto(`file://${file}`)
      await expect(opened.locator('pre.mermaid svg')).toBeVisible({ timeout: 15_000 })
      await expect(opened.locator('pre.mermaid svg')).toContainText('Start')
      expect(await opened.evaluate(() => document.documentElement.dataset.exportReady)).toBe('1')
    } finally {
      await opened.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
