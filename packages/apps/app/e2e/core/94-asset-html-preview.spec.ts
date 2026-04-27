import { test, expect, seed, goHome, clickProject, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import type { Page } from '@playwright/test'

const assetsPanel = (page: Page) => page.locator('[data-panel-id="assets"]:visible')
const sidebar = (page: Page) => assetsPanel(page).locator('[data-testid="assets-sidebar"]')
const assetRow = (page: Page, title: string) =>
  sidebar(page).locator('[data-testid^="asset-row-"]').filter({ hasText: title }).first()
const previewFrame = (page: Page) => assetsPanel(page).locator('iframe[title="HTML preview"]').contentFrame()

async function openAssetsPanel(page: Page) {
  if (await assetsPanel(page).isVisible().catch(() => false)) return
  await page.keyboard.press('Meta+Shift+A')
  await expect(assetsPanel(page)).toBeVisible({ timeout: 5_000 })
}

test.describe('HTML asset preview executes scripts', () => {
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

  test('inline <script> in .html asset runs and DOM mutations work', async ({ mainWindow }) => {
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
    await s.createAsset({ taskId, title: 'click-test.html', content: html })
    await s.refreshData()

    await openAssetsPanel(mainWindow)
    await assetRow(mainWindow, 'click-test.html').click()

    const frame = previewFrame(mainWindow)
    await expect(frame.locator('#r')).toHaveText('initial', { timeout: 5_000 })
    await frame.locator('#b').click()
    await expect(frame.locator('#r')).toHaveText('CLICKED', { timeout: 3_000 })
  })

  test('script can mutate DOM on load (no user interaction)', async ({ mainWindow }) => {
    const html = `<!DOCTYPE html><html><body>
      <div id="x">before</div>
      <script>document.getElementById('x').textContent = 'after';</script>
    </body></html>`

    const s = seed(mainWindow)
    await s.createAsset({ taskId, title: 'onload-test.html', content: html })
    await s.refreshData()

    await openAssetsPanel(mainWindow)
    await assetRow(mainWindow, 'onload-test.html').click()

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
    await s.createAsset({ taskId, title: 'canvas-test.html', content: html })
    await s.refreshData()

    await openAssetsPanel(mainWindow)
    await assetRow(mainWindow, 'canvas-test.html').click()

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
    await s.createAsset({ taskId, title: 'sandbox-test.html', content: html })
    await s.refreshData()

    await openAssetsPanel(mainWindow)
    await assetRow(mainWindow, 'sandbox-test.html').click()

    const frame = previewFrame(mainWindow)
    // Sandbox without allow-same-origin → origin is "null"
    await expect(frame.locator('#origin')).toHaveText('null', { timeout: 5_000 })
    // Cross-origin parent access blocked
    await expect(frame.locator('#parent')).toHaveText('BLOCKED', { timeout: 3_000 })
  })
})
