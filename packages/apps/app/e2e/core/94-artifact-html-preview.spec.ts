import {
  test,
  expect,
  seed,
  goHome,
  clickProject,
  resetApp,
  TEST_PROJECT_PATH
} from '../fixtures/electron'
import type { Locator, Page } from '@playwright/test'

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
 * `getFilePath` IPC → `slz-artifact://` fetch → parse+script — and reports all of them
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

/** A screen that shows the last `<slay-artifact-controls>` action, with a top and a bottom dock. */
const CONTROLS_HTML = `<!DOCTYPE html><html><head></head><body>
      <div id="state">idle</div>
      <main><slay-artifact-controls position="top">
        <button data-action="set" data-value="from-top">Top</button>
      </slay-artifact-controls></main>
      <slay-artifact-controls>
        <label>Qty <input id="qty" type="range" name="qty" min="1" max="9" value="3"></label>
      </slay-artifact-controls>
      <script>
        addEventListener('slay:action', (e) => {
          document.getElementById('state').textContent = e.detail.action + ':' + e.detail.value;
        });
      </script>
    </body></html>`

/**
 * Wait until a top/bottom dock is exactly as tall as its controls. Also the point
 * to click from: until then the dock is still being resized to the size it
 * reported, and a click sent in that window can land outside the frame.
 */
async function dockFitsControls(dock: Locator) {
  await expect
    .poll(async () => {
      const content = await dock
        .contentFrame()
        .locator('body')
        .evaluate((b) => Math.ceil(b.getBoundingClientRect().height))
      const height = await dock.evaluate((f) => f.getBoundingClientRect().height)
      return content > 0 && Math.abs(height - content) < 1
    })
    .toBe(true)
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
    await expect(mainWindow.locator('[data-testid="agent-trigger"]:visible').first()).toBeVisible({
      timeout: 5_000
    })
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
    // Sandboxed iframe — programmatic click via evaluate
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

  test('<slay-artifact-controls> docks drive the screen, which hides them', async ({
    mainWindow
  }) => {
    const html = CONTROLS_HTML

    const s = seed(mainWindow)
    await s.createArtifact({ taskId, title: 'controls-test.html', content: html })
    await s.refreshData()

    await openArtifactsPanel(mainWindow)
    await artifactRow(mainWindow, 'controls-test.html').click()
    await waitForPreviewLoaded(mainWindow)
    const screen = previewFrame(mainWindow)
    await expect(screen.locator('#state')).toHaveText('idle')
    await expect(screen.locator('slay-artifact-controls').first()).toBeHidden()

    const panel = artifactsPanel(mainWindow)
    const topDock = panel.locator('iframe[title="Artifact controls — top"]')
    const bottomDock = panel.locator('iframe[title="Artifact controls — bottom"]')
    await expect(topDock).toBeVisible()
    await expect(bottomDock).toBeVisible()
    const top = topDock.contentFrame()
    // A dock shows only its own controls, not the screen.
    await expect(top.locator('#state')).toBeHidden()
    await expect(top.locator('#qty')).toBeHidden()
    // …and is exactly as tall as they are.
    await dockFitsControls(topDock)

    await top.locator('button').click()
    await expect(screen.locator('#state')).toHaveText('set:from-top')
    await bottomDock.contentFrame().locator('#qty').fill('7')
    await expect(screen.locator('#state')).toHaveText('qty:7')
  })

  test('docks drive every device screen at once, through the device guests', async ({
    electronApp,
    mainWindow
  }) => {
    const s = seed(mainWindow)
    const artifact = await s.createArtifact({
      taskId,
      title: 'controls-devices.html',
      content: CONTROLS_HTML
    })
    if (!artifact) throw new Error('seed returned no artifact controls-devices.html')
    // Both screens of the Duo: two Chromium device guests (<webview>), not iframes.
    await mainWindow.evaluate((id) => {
      localStorage.setItem(
        'slayzone:artifact-device-preview:' + id,
        JSON.stringify({
          kind: 'preset',
          deviceId: 'iphone-duo',
          screen: 0,
          rotated: false,
          showBoth: true
        })
      )
      window.dispatchEvent(new Event('slayzone:artifact-device-preview-change'))
    }, artifact.id)
    await s.refreshData()

    await openArtifactsPanel(mainWindow)
    await artifactRow(mainWindow, 'controls-devices.html').click()
    const panel = artifactsPanel(mainWindow)
    await expect(panel.locator('webview[aria-label^="HTML device preview"]')).toHaveCount(2)
    const screens = () =>
      electronApp.evaluate(async ({ webContents }) =>
        Promise.all(
          webContents
            .getAllWebContents()
            .filter(
              (w) => w.getType() === 'webview' && w.getURL().includes('slayzone-preview=screen')
            )
            .map((w) =>
              w.executeJavaScript(
                `[document.getElementById('state')?.textContent, getComputedStyle(document.querySelector('slay-artifact-controls')).display].join(' ')`
              )
            )
        )
      )
    await expect.poll(screens, { timeout: 10_000 }).toEqual(['idle none', 'idle none'])

    const topDock = panel.locator('iframe[title="Artifact controls — top"]')
    await dockFitsControls(topDock)
    await topDock.contentFrame().locator('button').click()
    await expect.poll(screens).toEqual(['set:from-top none', 'set:from-top none'])
  })

  test('storage survives reopening and is private to each sandboxed artifact', async ({
    mainWindow
  }) => {
    const html = `<!DOCTYPE html><html><body>
      <div id="origin">?</div>
      <div id="parent">?</div>
      <div id="value">?</div>
      <button id="save">Save value</button>
      <script>
        document.getElementById('origin').textContent = self.origin;
        try {
          document.getElementById('parent').textContent = window.parent.location.href;
        } catch (e) {
          document.getElementById('parent').textContent = 'BLOCKED';
        }
        const value = document.getElementById('value');
        try {
          value.textContent = localStorage.getItem('checklist') ?? 'empty';
        } catch (error) {
          value.textContent = error.name;
        }
        document.getElementById('save').onclick = () => {
          localStorage.setItem('checklist', 'saved');
          value.textContent = localStorage.getItem('checklist');
        };
      </script>
    </body></html>`

    const s = seed(mainWindow)
    await s.createArtifact({ taskId, title: 'storage-first.html', content: html })
    await s.createArtifact({ taskId, title: 'storage-second.html', content: html })
    await s.refreshData()

    await openArtifactsPanel(mainWindow)
    await artifactRow(mainWindow, 'storage-first.html').click()
    await waitForPreviewLoaded(mainWindow)
    const frame = previewFrame(mainWindow)
    await expect(frame.locator('#value')).toHaveText('empty')
    await expect(frame.locator('#parent')).toHaveText('BLOCKED')
    await expect(frame.locator('#origin')).toHaveText(/^slz-artifact:\/\/artifact-/)
    const firstOrigin = (await frame.locator('#origin').innerText()).trim()
    await frame.locator('#save').click()
    await expect(frame.locator('#value')).toHaveText('saved')

    await artifactRow(mainWindow, 'storage-second.html').click()
    await waitForPreviewLoaded(mainWindow)
    await expect(frame.locator('#value')).toHaveText('empty')
    await expect(frame.locator('#origin')).not.toHaveText(firstOrigin)

    await artifactRow(mainWindow, 'storage-first.html').click()
    await waitForPreviewLoaded(mainWindow)
    await expect(frame.locator('#origin')).toHaveText(firstOrigin)
    await expect(frame.locator('#value')).toHaveText('saved')
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

    /** Task browser-panel tab URLs, as persisted. */
    const browserTabUrls = (page: Page) =>
      page.evaluate(async (id) => {
        const tasks = await window.getTrpcVanillaClient().task.getAll.query()
        const task = tasks.find((t) => t.id === id) as
          | { browser_tabs?: { tabs?: { url: string }[] } | null }
          | undefined
        return task?.browser_tabs?.tabs?.map((t) => t.url) ?? []
      }, taskId)

    /** Hold modifiers via the keyboard: Playwright's click `modifiers` don't reach MouseEvent flags in Electron. */
    async function withKeys(page: Page, keys: string[], action: () => Promise<void>) {
      for (const k of keys) await page.keyboard.down(k)
      try {
        await action()
      } finally {
        for (const k of [...keys].reverse()) await page.keyboard.up(k)
      }
    }

    const mouseUps = (page: Page) =>
      previewFrame(page)
        .locator('body')
        .evaluate(() => (window as unknown as { __mouseUps: number }).__mouseUps)

    /**
     * Click in the preview until the page actually receives it. Selecting an
     * artifact loads the (out-of-process) preview twice (`?v=N`, then `?v=N+1`);
     * a click right after the swap can be routed to the old document and lost —
     * measured: hit target was the iframe, the page saw no event. A lost click
     * did nothing, so retrying is safe.
     */
    async function clickInPreview(
      page: Page,
      selector: string,
      { keys = [], button = 'left' }: { keys?: string[]; button?: 'left' | 'middle' } = {}
    ) {
      await expect(async () => {
        const before = await mouseUps(page)
        await withKeys(page, keys, () => previewFrame(page).locator(selector).click({ button }))
        expect(await mouseUps(page)).toBeGreaterThan(before)
      }).toPass({ timeout: 5_000 })
    }

    async function openLinkArtifact(page: Page, title: string, extraScript = '') {
      const html = `<!DOCTYPE html><html><body>
        <a id="self" href="https://example.com/self">self</a>
        <a id="blank" href="https://example.com/blank" target="_blank">blank</a>
        <a id="hash" href="#section">hash</a>
        <a id="handled" href="https://example.com/handled">handled</a>
        <div id="section">section</div>
        <script>
          document.getElementById('handled').addEventListener('click', (e) => e.preventDefault());
          window.__mouseUps = 0;
          addEventListener('mouseup', () => window.__mouseUps++, true);
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
      await clickInPreview(mainWindow, '#self')
      await expect.poll(() => linkCalls(electronApp)).toEqual(['https://example.com/self'])
      // The iframe did not navigate away from the artifact.
      await expect(frame.locator('#section')).toHaveText('section')
    })

    test('target=_blank link opens externally', async ({ electronApp, mainWindow }) => {
      await clearLinkCalls(electronApp)
      await openLinkArtifact(mainWindow, 'link-blank.html')
      await clickInPreview(mainWindow, '#blank')
      await expect.poll(() => linkCalls(electronApp)).toEqual(['https://example.com/blank'])
    })

    test('hash links and page-handled links are left to the page', async ({
      electronApp,
      mainWindow
    }) => {
      await clearLinkCalls(electronApp)
      await openLinkArtifact(mainWindow, 'link-local.html')
      const frame = previewFrame(mainWindow)
      await clickInPreview(mainWindow, '#hash')
      await clickInPreview(mainWindow, '#handled')
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

    test('⌘⇧ click opens externally', async ({ electronApp, mainWindow }) => {
      await clearLinkCalls(electronApp)
      await openLinkArtifact(mainWindow, 'link-cmd-shift.html')
      await clickInPreview(mainWindow, '#self', { keys: ['Meta', 'Shift'] })
      await expect.poll(() => linkCalls(electronApp)).toEqual(['https://example.com/self'])
      expect(await browserTabUrls(mainWindow)).not.toContain('https://example.com/self')
    })

    // These open the browser panel — keep LAST.
    test("⌘ click opens in the task's in-app browser", async ({ electronApp, mainWindow }) => {
      await clearLinkCalls(electronApp)
      await openLinkArtifact(mainWindow, 'link-cmd.html')
      await clickInPreview(mainWindow, '#self', { keys: ['Meta'] })
      await expect.poll(() => browserTabUrls(mainWindow)).toContain('https://example.com/self')
      await expect(mainWindow.locator('[data-browser-panel]:visible').first()).toBeVisible()
      expect(await linkCalls(electronApp)).toEqual([])
    })

    test("middle click opens in the task's in-app browser", async ({ electronApp, mainWindow }) => {
      await clearLinkCalls(electronApp)
      await openLinkArtifact(mainWindow, 'link-middle.html')
      await clickInPreview(mainWindow, '#blank', { button: 'middle' })
      await expect.poll(() => browserTabUrls(mainWindow)).toContain('https://example.com/blank')
      expect(await linkCalls(electronApp)).toEqual([])
    })
  })
})
