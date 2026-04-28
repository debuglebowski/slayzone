import { test, expect, seed, goHome, clickProject, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import type { Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'

// --- Locators ---

const assetsPanel = (page: Page) => page.locator('[data-panel-id="assets"]:visible')
const sidebar = (page: Page) => assetsPanel(page).locator('[data-testid="assets-sidebar"]')
const assetRow = (page: Page, title: string) => sidebar(page).locator(`[data-testid^="asset-row-"]`).filter({ hasText: title }).first()
const folderRow = (page: Page, name: string) => sidebar(page).locator(`[data-testid^="folder-row-"]`).filter({ hasText: name }).first()
const createInput = (page: Page) => sidebar(page).locator('[data-testid="assets-create-input"]')
const renameInput = (page: Page) => sidebar(page).locator('[data-testid="assets-rename-input"]')

async function openAssetsPanel(page: Page) {
  // Cmd+Shift+A toggles assets panel
  if (await assetsPanel(page).isVisible().catch(() => false)) return
  await page.keyboard.press('Meta+Shift+A')
  await expect(assetsPanel(page)).toBeVisible({ timeout: 5_000 })
}

async function rightClick(page: Page, locator: import('@playwright/test').Locator) {
  await locator.click({ button: 'right' })
}

test.describe('Assets panel', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'AsPanel Test', color: '#f59e0b', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'Assets test task', status: 'todo' })
    taskId = t.id
    await s.refreshData()

    // Navigate to task
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('Assets test task').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('Assets test task').first().click()
    await expect(mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({ timeout: 5_000 })
  })

  // --- Group 1: Panel basics ---

  test('assets panel toggles with Cmd+Shift+A', async ({ mainWindow }) => {
    // Make sure panel is off first
    if (await assetsPanel(mainWindow).isVisible().catch(() => false)) {
      await mainWindow.keyboard.press('Meta+Shift+A')
      await expect(assetsPanel(mainWindow)).not.toBeVisible({ timeout: 3_000 })
    }

    // Toggle on
    await mainWindow.keyboard.press('Meta+Shift+A')
    await expect(assetsPanel(mainWindow)).toBeVisible({ timeout: 5_000 })

    // Toggle off
    await mainWindow.keyboard.press('Meta+Shift+A')
    await expect(assetsPanel(mainWindow)).not.toBeVisible({ timeout: 3_000 })
  })

  test('empty state shows message', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    await expect(sidebar(mainWindow).getByText('No assets yet')).toBeVisible({ timeout: 3_000 })
  })

  // --- Group 2: Asset CRUD ---

  test('create asset via header New button', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    await assetsPanel(mainWindow).locator('[data-testid="assets-new-btn"]').click()
    await expect(createInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await createInput(mainWindow).fill('notes.md')
    await createInput(mainWindow).press('Enter')
    await expect(assetRow(mainWindow, 'notes.md')).toBeVisible({ timeout: 3_000 })
  })

  test('asset count badge updates', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    // Header shows count
    await expect(assetsPanel(mainWindow).locator('.text-\\[10px\\].text-muted-foreground').first()).toContainText('1')
  })

  test('select asset shows content editor', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    await assetRow(mainWindow, 'notes.md').click()
    // The right pane should show an editor (RichTextEditor for .md in preview mode)
    await expect(assetsPanel(mainWindow).locator('.ProseMirror, textarea').first()).toBeVisible({ timeout: 3_000 })
  })

  test('create asset via root context menu', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    await rightClick(mainWindow, sidebar(mainWindow))
    await expect(mainWindow.getByRole('menuitem', { name: 'New Asset' })).toBeVisible({ timeout: 3_000 })
    await mainWindow.getByRole('menuitem', { name: 'New Asset' }).click()
    await expect(createInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await createInput(mainWindow).fill('schema.sql')
    await createInput(mainWindow).press('Enter')
    await expect(assetRow(mainWindow, 'schema.sql')).toBeVisible({ timeout: 3_000 })
  })

  test('rename asset via context menu', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    await rightClick(mainWindow, assetRow(mainWindow, 'schema.sql'))
    await expect(mainWindow.getByRole('menuitem', { name: 'Rename' })).toBeVisible({ timeout: 3_000 })
    await mainWindow.getByRole('menuitem', { name: 'Rename' }).click()
    await expect(renameInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await renameInput(mainWindow).fill('schema.json')
    await renameInput(mainWindow).press('Enter')
    await expect(assetRow(mainWindow, 'schema.json')).toBeVisible({ timeout: 3_000 })
    await expect(assetRow(mainWindow, 'schema.sql')).not.toBeVisible({ timeout: 2_000 })
  })

  test('delete asset via context menu', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    await rightClick(mainWindow, assetRow(mainWindow, 'schema.json'))
    await expect(mainWindow.getByRole('menuitem', { name: 'Delete' })).toBeVisible({ timeout: 3_000 })
    await mainWindow.getByRole('menuitem', { name: 'Delete' }).click()
    await expect(assetRow(mainWindow, 'schema.json')).not.toBeVisible({ timeout: 3_000 })
  })

  // --- Group 3: Folder CRUD ---

  test('create folder via header button', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    await assetsPanel(mainWindow).locator('[data-testid="assets-folder-btn"]').click()
    await expect(createInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await createInput(mainWindow).fill('designs')
    await createInput(mainWindow).press('Enter')
    await expect(folderRow(mainWindow, 'designs')).toBeVisible({ timeout: 3_000 })
  })

  test('create folder via root context menu', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    await rightClick(mainWindow, sidebar(mainWindow))
    await expect(mainWindow.getByRole('menuitem', { name: 'New Folder' })).toBeVisible({ timeout: 3_000 })
    await mainWindow.getByRole('menuitem', { name: 'New Folder' }).click()
    await expect(createInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await createInput(mainWindow).fill('docs')
    await createInput(mainWindow).press('Enter')
    await expect(folderRow(mainWindow, 'docs')).toBeVisible({ timeout: 3_000 })
  })

  test('create asset inside folder via context menu', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    await rightClick(mainWindow, folderRow(mainWindow, 'designs'))
    await expect(mainWindow.getByRole('menuitem', { name: 'New Asset' })).toBeVisible({ timeout: 3_000 })
    await mainWindow.getByRole('menuitem', { name: 'New Asset' }).click()
    await expect(createInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await createInput(mainWindow).fill('mockup.svg')
    await createInput(mainWindow).press('Enter')
    await expect(assetRow(mainWindow, 'mockup.svg')).toBeVisible({ timeout: 3_000 })
  })

  test('create subfolder via folder context menu', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    await rightClick(mainWindow, folderRow(mainWindow, 'designs'))
    await expect(mainWindow.getByRole('menuitem', { name: 'New Folder' })).toBeVisible({ timeout: 3_000 })
    await mainWindow.getByRole('menuitem', { name: 'New Folder' }).click()
    await expect(createInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await createInput(mainWindow).fill('icons')
    await createInput(mainWindow).press('Enter')
    await expect(folderRow(mainWindow, 'icons')).toBeVisible({ timeout: 3_000 })
  })

  test('rename folder via context menu', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    await rightClick(mainWindow, folderRow(mainWindow, 'docs'))
    await expect(mainWindow.getByRole('menuitem', { name: 'Rename' })).toBeVisible({ timeout: 3_000 })
    await mainWindow.getByRole('menuitem', { name: 'Rename' }).click()
    await expect(renameInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await renameInput(mainWindow).fill('documentation')
    await renameInput(mainWindow).press('Enter')
    await expect(folderRow(mainWindow, 'documentation')).toBeVisible({ timeout: 3_000 })
    await expect(folderRow(mainWindow, 'docs')).not.toBeVisible({ timeout: 2_000 })
  })

  test('delete folder moves assets to root', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)

    // Create an asset inside documentation folder
    await rightClick(mainWindow, folderRow(mainWindow, 'documentation'))
    await mainWindow.getByRole('menuitem', { name: 'New Asset' }).click()
    await createInput(mainWindow).fill('guide.md')
    await createInput(mainWindow).press('Enter')
    await expect(assetRow(mainWindow, 'guide.md')).toBeVisible({ timeout: 3_000 })

    // Delete the folder
    await rightClick(mainWindow, folderRow(mainWindow, 'documentation'))
    await mainWindow.getByRole('menuitem', { name: 'Delete' }).click()

    // Folder gone, but asset still exists at root
    await expect(folderRow(mainWindow, 'documentation')).not.toBeVisible({ timeout: 3_000 })
    await expect(assetRow(mainWindow, 'guide.md')).toBeVisible({ timeout: 3_000 })
  })

  // --- Group 4: Context menu items ---

  test('asset context menu has correct items', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    await rightClick(mainWindow, assetRow(mainWindow, 'notes.md'))

    await expect(mainWindow.getByRole('menuitem', { name: 'Rename' })).toBeVisible({ timeout: 3_000 })
    await expect(mainWindow.getByRole('menuitem', { name: 'Copy Path' })).toBeVisible()
    await expect(mainWindow.getByRole('menuitem', { name: 'Delete' })).toBeVisible()

    // Close menu
    await mainWindow.keyboard.press('Escape')
  })

  test('folder context menu has correct items', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    await rightClick(mainWindow, folderRow(mainWindow, 'designs'))

    await expect(mainWindow.getByRole('menuitem', { name: 'New Asset' })).toBeVisible({ timeout: 3_000 })
    await expect(mainWindow.getByRole('menuitem', { name: 'New Folder' })).toBeVisible()
    await expect(mainWindow.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
    await expect(mainWindow.getByRole('menuitem', { name: 'Delete' })).toBeVisible()

    await mainWindow.keyboard.press('Escape')
  })

  test('root context menu has New Asset and New Folder', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    // Right-click on empty space in sidebar
    await sidebar(mainWindow).click({ button: 'right', position: { x: 10, y: 5 } })

    await expect(mainWindow.getByRole('menuitem', { name: 'New Asset' })).toBeVisible({ timeout: 3_000 })
    await expect(mainWindow.getByRole('menuitem', { name: 'New Folder' })).toBeVisible()

    await mainWindow.keyboard.press('Escape')
  })

  // --- Group 5: Content editing ---

  test('view mode toggle works for markdown', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    await assetRow(mainWindow, 'notes.md').click()

    // Should be in preview mode (WYSIWYG) by default
    await expect(assetsPanel(mainWindow).locator('.ProseMirror').first()).toBeVisible({ timeout: 3_000 })

    // Click split mode
    const splitBtn = assetsPanel(mainWindow).locator('button').filter({ hasText: 'Split' }).first()
    if (await splitBtn.isVisible().catch(() => false)) {
      await splitBtn.click()
      // Should see both textarea and preview
      await expect(assetsPanel(mainWindow).locator('textarea').first()).toBeVisible({ timeout: 3_000 })
    }
  })

  // --- Group 6: Empty folder renders ---

  test('empty folder is visible in tree', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    // The "icons" subfolder should still be visible even if empty
    await expect(folderRow(mainWindow, 'icons')).toBeVisible({ timeout: 3_000 })
  })

  // --- Group 7: Inline create escape cancels ---

  test('pressing Escape cancels inline creation', async ({ mainWindow }) => {
    await openAssetsPanel(mainWindow)
    await assetsPanel(mainWindow).locator('[data-testid="assets-new-btn"]').click()
    await expect(createInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await createInput(mainWindow).press('Escape')
    await expect(createInput(mainWindow)).not.toBeVisible({ timeout: 2_000 })
  })

  // --- Group 8: Seed-based tests ---

  test('seeded assets appear in panel', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    await s.createAsset({ taskId, title: 'seeded.txt', content: 'hello world' })
    await s.refreshData()

    await openAssetsPanel(mainWindow)
    await expect(assetRow(mainWindow, 'seeded.txt')).toBeVisible({ timeout: 5_000 })
  })

  test('seeded folder with asset renders correctly', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const folder = await s.createAssetFolder({ taskId, name: 'seeded-folder' })
    await s.createAsset({ taskId, title: 'nested.md', folderId: folder.id })
    await s.refreshData()

    await openAssetsPanel(mainWindow)
    await expect(folderRow(mainWindow, 'seeded-folder')).toBeVisible({ timeout: 5_000 })
    await expect(assetRow(mainWindow, 'nested.md')).toBeVisible({ timeout: 3_000 })
  })

  // --- Group 9: External-sync banner + caret preservation ---

  test('conflict banner is absolute-positioned and does not shift editor', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const asset = await s.createAsset({ taskId, title: 'sync-banner.md', content: 'initial\n' })
    await s.refreshData()

    await openAssetsPanel(mainWindow)
    await assetRow(mainWindow, 'sync-banner.md').click()

    // Switch to split mode so we get a SearchableCodeView (CodeMirror) with predictable bbox
    const splitBtn = assetsPanel(mainWindow).locator('button[aria-pressed]').filter({ has: mainWindow.locator('.lucide-columns-2') }).first()
    if (await splitBtn.isVisible().catch(() => false)) await splitBtn.click()

    const editor = assetsPanel(mainWindow).locator('.cm-editor').first()
    await expect(editor).toBeVisible({ timeout: 5_000 })

    // Resolve disk path for external write
    const filePath = await mainWindow.evaluate((id) => (window as any).api.assets.getFilePath(id), asset.id)
    expect(filePath).toBeTruthy()

    // Dirty the buffer
    await editor.locator('.cm-content').click()
    await mainWindow.keyboard.type('local edits')

    const before = await editor.boundingBox()
    expect(before).toBeTruthy()

    // External write to provoke mtime mismatch → conflict banner
    fs.writeFileSync(filePath as string, 'external write\n')

    const banner = assetsPanel(mainWindow).locator('[data-testid="asset-conflict-banner"]')
    await expect(banner).toBeVisible({ timeout: 5_000 })

    // Banner is absolute-positioned (toast), not flow content
    const position = await banner.evaluate((el) => getComputedStyle(el).position)
    expect(position).toBe('absolute')

    // Editor bbox must not have shifted — banner appearance is layout-neutral
    const after = await editor.boundingBox()
    expect(after).toBeTruthy()
    expect(Math.round(after!.y)).toBe(Math.round(before!.y))
    expect(Math.round(after!.height)).toBe(Math.round(before!.height))

    // Reload + Keep mine remain reachable
    await expect(banner.locator('[data-testid="asset-conflict-reload"]')).toBeVisible()
    await expect(banner.locator('[data-testid="asset-conflict-keep"]')).toBeVisible()

    // Cleanup: keep-mine to clear conflict before next test
    await banner.locator('[data-testid="asset-conflict-keep"]').click()
    await expect(banner).not.toBeVisible({ timeout: 3_000 })
  })

  test('caret survives save round-trip in code editor', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    await s.createAsset({ taskId, title: 'caret-test.txt', content: '' })
    await s.refreshData()

    await openAssetsPanel(mainWindow)
    await assetRow(mainWindow, 'caret-test.txt').click()

    const editor = assetsPanel(mainWindow).locator('.cm-editor').first()
    await expect(editor).toBeVisible({ timeout: 5_000 })

    const cmContent = editor.locator('.cm-content')
    await cmContent.click()

    // Type, wait past 500ms save debounce, type more. Caret must remain at end →
    // final doc string is in the order typed, not reset/reordered by replaceAll.
    await mainWindow.keyboard.type('abc')
    await mainWindow.waitForTimeout(800)
    await mainWindow.keyboard.type('def')

    await expect.poll(
      async () => cmContent.evaluate((el) => el.textContent ?? ''),
      { timeout: 3_000 }
    ).toBe('abcdef')
  })
})
