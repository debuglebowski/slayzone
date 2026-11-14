/**
 * Review 4, M1, in a real browser: the shared export document's CSP leaves an
 * artifact's own markup inert (`<img onerror>`, `<script>`, SVG handlers), while what
 * rendering needs still runs — mermaid (nonce'd) and a caller's own nonce'd script
 * (the phone's PNG capture page). Chrome-family, the engine desktop, the CLI and the
 * web shell render in; the phone's WebKit honours the same meta policy. Skipped when
 * this machine has no browser.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  EXPORT_READY_EXPRESSION,
  buildDocumentHtml,
  buildPngHtml
} from '@slayzone/task-artifacts/export-html'
import { defaultBrowserEnv, findBrowser } from './browser'
import { type Browser, launchBrowser } from './cdp'
import { loadMermaidJs } from './mermaid-js'

const BROWSER = findBrowser(defaultBrowserEnv())

describe.skipIf(!BROWSER)('export document policy in a real browser', () => {
  let b: Browser
  beforeAll(async () => {
    b = await launchBrowser(BROWSER as string)
  }, 60_000)
  afterAll(async () => {
    await b?.close()
  })

  /** Load `html`, wait for it, and return `probe` evaluated in it. */
  async function load<T>(html: string, probe: string, settleMs = 300): Promise<T> {
    const { targetId } = await b.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank'
    })
    const { sessionId } = await b.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true
    })
    const { frameTree } = await b.send<{ frameTree: { frame: { id: string } } }>(
      'Page.getFrameTree',
      {},
      sessionId
    )
    await b.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, sessionId)
    await new Promise((r) => setTimeout(r, settleMs))
    const r = await b.send<{ result: { value: T } }>(
      'Runtime.evaluate',
      { expression: probe, returnByValue: true, awaitPromise: true },
      sessionId
    )
    await b.send('Target.closeTarget', { targetId })
    return r.result.value
  }

  const PWNED = 'String(window.__pwned ?? "")'

  test('markdown: an <img onerror> and a <script> never run', { timeout: 30_000 }, async () => {
    const html = buildDocumentHtml(
      '# Report\n\n<img src="x" onerror="window.__pwned = (window.__pwned || \'\') + \'img\'">\n\n<script>window.__pwned = (window.__pwned || "") + "script"</script>\n',
      'markdown',
      'r.md'
    )
    expect(await load<string>(html, PWNED)).toBe('')
  })

  test('svg: an onload handler never runs', { timeout: 30_000 }, async () => {
    const html = buildPngHtml(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="window.__pwned=\'svg\'"><rect width="10" height="10"/></svg>',
      'svg-preview',
      's.svg'
    )
    expect(await load<string>(html as string, PWNED)).toBe('')
  })

  test('mermaid still draws under the policy (document and PNG)', { timeout: 60_000 }, async () => {
    const code = 'graph TD\n  A[Start] --> B{Choice}\n  B --> C[End]\n'
    for (const html of [
      buildDocumentHtml(code, 'mermaid-preview', 'd.mmd', loadMermaidJs()),
      buildPngHtml(code, 'mermaid-preview', 'd.mmd', loadMermaidJs()) as string
    ]) {
      const drawn = await load<{ ready: boolean; svg: boolean; label: boolean }>(
        html,
        `new Promise((resolve) => { const t0 = Date.now(); (function poll() {
           if (${EXPORT_READY_EXPRESSION} || Date.now() - t0 > 10000) resolve({
             ready: ${EXPORT_READY_EXPRESSION},
             svg: !!document.querySelector('.mermaid svg'),
             label: (document.querySelector('.mermaid svg')?.textContent ?? '').includes('Choice')
           }); else setTimeout(poll, 50) })() })`,
        50
      )
      expect(drawn).toEqual({ ready: true, svg: true, label: true })
    }
  })

  test("a caller's nonce'd script runs; one without the nonce does not", {
    timeout: 30_000
  }, async () => {
    const html = (
      buildPngHtml('<svg></svg>', 'svg-preview', 't', null, { nonce: 'n0nce' }) as string
    ).replace(
      '</body>',
      '<script nonce="n0nce">window.__ok = "yes"</script><script>window.__pwned = "x"</script></body>'
    )
    expect(
      await load<string>(html, 'String(window.__ok ?? "") + "|" + String(window.__pwned ?? "")')
    ).toBe('yes|')
  })

  test('html-preview: inert by default, scripts only where the host opts in', {
    timeout: 30_000
  }, async () => {
    const page = '<p>x</p><script>window.__pwned = "ran"</script>'
    expect(await load<string>(buildDocumentHtml(page, 'html-preview', 'p.html'), PWNED)).toBe('')
    expect(
      await load<string>(
        buildDocumentHtml(page, 'html-preview', 'p.html', null, { artifactScripts: true }),
        PWNED
      )
    ).toBe('ran')
  })
})
