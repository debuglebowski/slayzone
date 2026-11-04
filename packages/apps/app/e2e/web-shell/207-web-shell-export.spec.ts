import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { chromium, test, expect, type Browser, type Page } from '@playwright/test'

/**
 * Artifact export in the web shell, against a REAL standalone hub — the case that used
 * to answer 501 (no Electron next to the hub to render on). Export now renders in the
 * person's own browser, so the hub only serves the page.
 *
 * What only a real browser + the real hub can prove: the shell's exporter works under
 * the hub's Content-Security-Policy (a `srcdoc` frame inherits `script-src 'self'`, so
 * nothing may depend on inline script), the mermaid chunk loads from the real bundle,
 * and an artifact's own script never runs with the shell's origin.
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
})
