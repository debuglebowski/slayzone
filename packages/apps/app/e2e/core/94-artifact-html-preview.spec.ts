import { test, expect, seed, goHome, clickProject, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import type { Page } from '@playwright/test'

const artifactsPanel = (page: Page) => page.locator('[data-panel-id="artifacts"]:visible')
const sidebar = (page: Page) => artifactsPanel(page).locator('[data-testid="artifacts-sidebar"]')
const artifactRow = (page: Page, title: string) =>
  sidebar(page).locator('[data-testid^="artifact-row-"]').filter({ hasText: title }).first()
const previewFrame = (page: Page) => artifactsPanel(page).locator('iframe[title="HTML preview"]').contentFrame()

async function openArtifactsPanel(page: Page) {
  if (await artifactsPanel(page).isVisible().catch(() => false)) return
  await page.keyboard.press('Meta+Shift+A')
  await expect(artifactsPanel(page)).toBeVisible({ timeout: 5_000 })
}

test.describe('HTML artifact preview executes scripts', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'HTML Preview Test', color: '#3b82f6', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'HTML preview task', status: 'todo' })
    taskId = t.id
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('HTML preview task').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('HTML preview task').first().click()
    await expect(mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({ timeout: 5_000 })
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

    const frame = previewFrame(mainWindow)
    // Sandbox without allow-same-origin → origin is "null"
    await expect(frame.locator('#origin')).toHaveText('null', { timeout: 5_000 })
    // Cross-origin parent access blocked
    await expect(frame.locator('#parent')).toHaveText('BLOCKED', { timeout: 3_000 })
  })
})
