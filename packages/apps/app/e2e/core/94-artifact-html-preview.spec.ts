import {
  test,
  expect,
  seed,
  goHome,
  clickProject,
  resetApp,
  TEST_PROJECT_PATH
} from '../fixtures/electron'
import type { Page } from '@playwright/test'

const artifactsPanel = (page: Page) => page.locator('[data-panel-id="artifacts"]:visible')
const sidebar = (page: Page) => artifactsPanel(page).locator('[data-testid="artifacts-sidebar"]')
const artifactRow = (page: Page, title: string) =>
  sidebar(page).locator('[data-testid^="artifact-row-"]').filter({ hasText: title }).first()
const previewFrame = (page: Page) =>
  artifactsPanel(page).locator('iframe[title="HTML preview"]').contentFrame()

/**
 * Wait for the preview through its REAL stages instead of one composite budget.
 *
 * `expect(frame.locator('#x')).toHaveText(...)` spans four hops — React commit →
 * `getFilePath` IPC → `slz-file://` fetch → parse+script — and reports all of them
 * as `element(s) not found`, which cannot distinguish "iframe never mounted" from
 * "document never loaded". These tests otherwise run in 0.1–0.3s against a 5s
 * ceiling, so when one fails it is stuck, not slow; naming the stuck hop is the
 * whole diagnostic value. The pane now surfaces its own failure, so assert that
 * first — a resolved error beats waiting out a timeout on a pane that already knows.
 */
async function waitForPreviewLoaded(page: Page) {
  const panel = artifactsPanel(page)
  const error = panel.locator('[data-testid="html-preview-error"]')
  const iframe = panel.locator('iframe[title="HTML preview"]')

  await expect(async () => {
    if (await error.isVisible().catch(() => false)) {
      throw new Error(`HTML preview reported an error: ${await error.innerText()}`)
    }
    await expect(iframe).toBeAttached({ timeout: 1_000 })
  }).toPass({ timeout: 8_000 })

  // The frame exists; now prove its document actually finished loading, so a
  // content assertion that fails is about the CONTENT and nothing earlier.
  await expect
    .poll(
      async () =>
        previewFrame(page)
          .locator('body')
          .evaluate((b) => b.ownerDocument.readyState)
          .catch(() => 'unavailable'),
      { timeout: 8_000 }
    )
    .toBe('complete')
}

async function openArtifactsPanel(page: Page) {
  if (
    await artifactsPanel(page)
      .isVisible()
      .catch(() => false)
  )
    return
  await page.keyboard.press('Meta+Shift+A')
  await expect(artifactsPanel(page)).toBeVisible({ timeout: 5_000 })
}

test.describe('HTML artifact preview executes scripts', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)
    // Capture shell.openExternal so link clicks are observable without
    // launching a real browser.
    await electronApp.evaluate(({ shell }) => {
      const g = globalThis as Record<string, unknown>
      g.__htmlLinkCalls = [] as string[]
      g.__htmlLinkOriginal = shell.openExternal.bind(shell)
      Object.defineProperty(shell, 'openExternal', {
        configurable: true,
        writable: true,
        value: async (url: string) => {
          ;(g.__htmlLinkCalls as string[]).push(url)
        }
      })
    })
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'HTML Preview Test',
      color: '#3b82f6',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'HTML preview task', status: 'todo' })
    taskId = t.id
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('HTML preview task').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('HTML preview task').first().click()
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })
  })

  test.afterAll(async ({ electronApp }) => {
    await electronApp.evaluate(({ shell }) => {
      const g = globalThis as Record<string, unknown>
      if (g.__htmlLinkOriginal) {
        Object.defineProperty(shell, 'openExternal', {
          configurable: true,
          writable: true,
          value: g.__htmlLinkOriginal
        })
      }
      delete g.__htmlLinkCalls
      delete g.__htmlLinkOriginal
    })
  })

  test('inline <script> in .html artifact runs and DOM mutations work', async ({ mainWindow }) => {
    const html = `<!DOCTYPE html><html><body>
      <button id="b">click me</button>
      <div id="r">initial</div>
      <script>
        document.getElementById('b').addEventListener('click', () => {
          document.getElementById('r').textContent = 'CLICKED';
        });
      </script>
    </body></html>`

    const s = seed(mainWindow)
    await s.createArtifact({ taskId, title: 'click-test.html', content: html })
    await s.refreshData()

    await openArtifactsPanel(mainWindow)
    await artifactRow(mainWindow, 'click-test.html').click()

    await waitForPreviewLoaded(mainWindow)
    const frame = previewFrame(mainWindow)
    await expect(frame.locator('#r')).toHaveText('initial', { timeout: 5_000 })
    // Sandboxed iframe (allow-scripts only) — programmatic click via evaluate
    // is more reliable than Playwright's input dispatch into a sandbox.
    await frame.locator('#b').evaluate((el: HTMLElement) => el.click())
    await expect(frame.locator('#r')).toHaveText('CLICKED', { timeout: 3_000 })
  })

  test('script can mutate DOM on load (no user interaction)', async ({ mainWindow }) => {
    const html = `<!DOCTYPE html><html><body>
      <div id="x">before</div>
      <script>document.getElementById('x').textContent = 'after';</script>
    </body></html>`

    const s = seed(mainWindow)
    await s.createArtifact({ taskId, title: 'onload-test.html', content: html })
    await s.refreshData()

    await openArtifactsPanel(mainWindow)
    await artifactRow(mainWindow, 'onload-test.html').click()

    await waitForPreviewLoaded(mainWindow)
    const frame = previewFrame(mainWindow)
    await expect(frame.locator('#x')).toHaveText('after', { timeout: 5_000 })
  })

  test('canvas element renders (proves <canvas> + 2d context work)', async ({ mainWindow }) => {
    const html = `<!DOCTYPE html><html><body>
      <canvas id="c" width="50" height="50"></canvas>
      <div id="ok">no</div>
      <script>
        const ctx = document.getElementById('c').getContext('2d');
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(0, 0, 50, 50);
        document.getElementById('ok').textContent = 'yes';
      </script>
    </body></html>`

    const s = seed(mainWindow)
    await s.createArtifact({ taskId, title: 'canvas-test.html', content: html })
    await s.refreshData()

    await openArtifactsPanel(mainWindow)
    await artifactRow(mainWindow, 'canvas-test.html').click()

    await waitForPreviewLoaded(mainWindow)
    const frame = previewFrame(mainWindow)
    await expect(frame.locator('#ok')).toHaveText('yes', { timeout: 5_000 })
  })

  test('iframe is sandboxed (no parent window access, unique origin)', async ({ mainWindow }) => {
    const html = `<!DOCTYPE html><html><body>
      <div id="origin">?</div>
      <div id="parent">?</div>
      <script>
        document.getElementById('origin').textContent = location.origin;
        try {
          document.getElementById('parent').textContent = window.parent.location.href;
        } catch (e) {
          document.getElementById('parent').textContent = 'BLOCKED';
        }
      </script>
    </body></html>`

    const s = seed(mainWindow)
    await s.createArtifact({ taskId, title: 'sandbox-test.html', content: html })
    await s.refreshData()

    await openArtifactsPanel(mainWindow)
    await artifactRow(mainWindow, 'sandbox-test.html').click()

    await waitForPreviewLoaded(mainWindow)
    const frame = previewFrame(mainWindow)
    // slz-file is a standard, secure scheme (needed for Storage APIs in artifact
    // previews) — sandbox without allow-same-origin still surfaces the scheme as
    // origin rather than the spec-default "null". The cross-origin barrier is
    // what we really care about; assert that parent access is blocked.
    await expect(frame.locator('#origin')).toHaveText(/slz-file:\/\//, { timeout: 5_000 })
    await expect(frame.locator('#parent')).toHaveText('BLOCKED', { timeout: 3_000 })
  })

  test.describe('links', () => {
    const linkCalls = (electronApp: import('@playwright/test').ElectronApplication) =>
      electronApp.evaluate(() => [
        ...((globalThis as Record<string, unknown>).__htmlLinkCalls as string[])
      ])
    const clearLinkCalls = (electronApp: import('@playwright/test').ElectronApplication) =>
      electronApp.evaluate(() => {
        ;(globalThis as Record<string, unknown>).__htmlLinkCalls = []
      })

    async function openLinkArtifact(page: Page, title: string, extraScript = '') {
      const html = `<!DOCTYPE html><html><body>
        <a id="self" href="https://example.com/self">self</a>
        <a id="blank" href="https://example.com/blank" target="_blank">blank</a>
        <a id="hash" href="#section">hash</a>
        <a id="handled" href="https://example.com/handled">handled</a>
        <div id="section">section</div>
        <script>
          document.getElementById('handled').addEventListener('click', (e) => e.preventDefault());
          ${extraScript}
        </script>
      </body></html>`
      const s = seed(page)
      await s.createArtifact({ taskId, title, content: html })
      await s.refreshData()
      await openArtifactsPanel(page)
      await artifactRow(page, title).click()
      await waitForPreviewLoaded(page)
      // Main injects the bridge asynchronously on dom-ready; a click before it
      // lands takes the sandbox's default path.
      await expect
        .poll(() =>
          previewFrame(page)
            .locator('body')
            .evaluate(
              () => (window as unknown as Record<string, unknown>).__slzHtmlPreviewLinkBridge
            )
            .catch(() => undefined)
        )
        .toBe(true)
    }

    test('bare click on http link opens externally, preview stays put', async ({
      electronApp,
      mainWindow
    }) => {
      await clearLinkCalls(electronApp)
      await openLinkArtifact(mainWindow, 'link-self.html')
      const frame = previewFrame(mainWindow)
      await frame.locator('#self').click()
      await expect.poll(() => linkCalls(electronApp)).toEqual(['https://example.com/self'])
      // The iframe did not navigate away from the artifact.
      await expect(frame.locator('#section')).toHaveText('section')
    })

    test('target=_blank link opens externally', async ({ electronApp, mainWindow }) => {
      await clearLinkCalls(electronApp)
      await openLinkArtifact(mainWindow, 'link-blank.html')
      await previewFrame(mainWindow).locator('#blank').click()
      await expect.poll(() => linkCalls(electronApp)).toEqual(['https://example.com/blank'])
    })

    test('hash links and page-handled links are left to the page', async ({
      electronApp,
      mainWindow
    }) => {
      await clearLinkCalls(electronApp)
      await openLinkArtifact(mainWindow, 'link-local.html')
      const frame = previewFrame(mainWindow)
      await frame.locator('#hash').click()
      await frame.locator('#handled').click()
      await mainWindow.waitForTimeout(300)
      expect(await linkCalls(electronApp)).toEqual([])
      await expect(frame.locator('#section')).toHaveText('section')
    })

    test('a script-forged link message without a user gesture is ignored', async ({
      electronApp,
      mainWindow
    }) => {
      await clearLinkCalls(electronApp)
      // Fires long after any real click's transient activation (~5s) expired.
      await openLinkArtifact(
        mainWindow,
        'link-forged.html',
        `setTimeout(() => {
          window.top.postMessage({ type: 'slayzone:html-preview-link',
            url: 'https://example.com/forged', metaKey: false, ctrlKey: false,
            shiftKey: false }, '*');
          document.getElementById('section').textContent = 'forged';
        }, 6000);`
      )
      // Hands off until it fired: every Playwright evaluate/poll runs with a user
      // gesture — the exact thing the renderer gates on. The page's timer has none.
      await mainWindow.waitForTimeout(7_000)
      await expect(previewFrame(mainWindow).locator('#section')).toHaveText('forged')
      expect(await linkCalls(electronApp)).toEqual([])
    })
  })
})
