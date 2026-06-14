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
import fs from 'fs'
import path from 'path'

// --- Locators ---

const artifactsPanel = (page: Page) => page.locator('[data-panel-id="artifacts"]:visible')
const sidebar = (page: Page) => artifactsPanel(page).locator('[data-testid="artifacts-sidebar"]')
const artifactRow = (page: Page, title: string) =>
  sidebar(page)
    .locator(`[data-testid^="artifact-row-"]`)
    .filter({ has: page.locator('span', { hasText: title }) })
    .locator('button')
    .filter({ has: page.locator('span', { hasText: title }) })
    .first()
const folderRow = (page: Page, name: string) =>
  // Scope to the folder's own clickable button (not the expanded children that share the data-testid wrapper).
  sidebar(page)
    .locator(`[data-testid^="folder-row-"]`)
    .filter({ has: page.locator('button', { hasText: name }) })
    .locator('button')
    .filter({ hasText: name })
    .first()
const createInput = (page: Page) => sidebar(page).locator('[data-testid="artifacts-create-input"]')
const renameInput = (page: Page) => sidebar(page).locator('[data-testid="artifacts-rename-input"]')

async function openArtifactsPanel(page: Page) {
  // Cmd+Shift+A toggles artifacts panel
  if (
    await artifactsPanel(page)
      .isVisible()
      .catch(() => false)
  )
    return
  await page.keyboard.press('Meta+Shift+A')
  await expect(artifactsPanel(page)).toBeVisible({ timeout: 5_000 })
}

async function rightClick(page: Page, locator: import('@playwright/test').Locator) {
  await locator.click({ button: 'right' })
}

test.describe('Artifacts panel', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)

    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'AsPanel Test',
      color: '#f59e0b',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'Artifacts test task', status: 'todo' })
    taskId = t.id
    await s.refreshData()

    // Navigate to task
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('Artifacts test task').first()).toBeVisible({
      timeout: 5_000
    })
    await mainWindow.getByText('Artifacts test task').first().click()
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })
  })

  // --- Group 1: Panel basics ---

  test('artifacts panel toggles with Cmd+Shift+A', async ({ mainWindow }) => {
    // Make sure panel is off first
    if (
      await artifactsPanel(mainWindow)
        .isVisible()
        .catch(() => false)
    ) {
      await mainWindow.keyboard.press('Meta+Shift+A')
      await expect(artifactsPanel(mainWindow)).not.toBeVisible({ timeout: 3_000 })
    }

    // Toggle on
    await mainWindow.keyboard.press('Meta+Shift+A')
    await expect(artifactsPanel(mainWindow)).toBeVisible({ timeout: 5_000 })

    // Toggle off
    await mainWindow.keyboard.press('Meta+Shift+A')
    await expect(artifactsPanel(mainWindow)).not.toBeVisible({ timeout: 3_000 })
  })

  test('empty state shows message', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    await expect(sidebar(mainWindow).getByText('No artifacts yet')).toBeVisible({ timeout: 3_000 })
  })

  // --- Group 2: Artifact CRUD ---

  test('create artifact via header New button', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    await artifactsPanel(mainWindow).locator('[data-testid="artifacts-new-btn"]').click()
    await expect(createInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await createInput(mainWindow).fill('notes.md')
    await createInput(mainWindow).press('Enter')
    await expect(artifactRow(mainWindow, 'notes.md')).toBeVisible({ timeout: 3_000 })
  })

  test('artifact appears in tree after creation', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    // The seeded artifact from the previous test should be visible.
    await expect(artifactRow(mainWindow, 'notes.md')).toBeVisible({ timeout: 3_000 })
  })

  test('select artifact shows content editor', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    await artifactRow(mainWindow, 'notes.md').click()
    // The right pane should show an editor (RichTextEditor for .md in preview mode)
    await expect(artifactsPanel(mainWindow).locator('.ProseMirror, textarea').first()).toBeVisible({
      timeout: 3_000
    })
  })

  test('create artifact via root context menu', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    await rightClick(mainWindow, sidebar(mainWindow))
    await expect(mainWindow.getByRole('menuitem', { name: 'New Artifact' })).toBeVisible({
      timeout: 3_000
    })
    await mainWindow.getByRole('menuitem', { name: 'New Artifact' }).first().click()
    await expect(createInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await createInput(mainWindow).fill('schema.sql')
    await createInput(mainWindow).press('Enter')
    await expect(artifactRow(mainWindow, 'schema.sql')).toBeVisible({ timeout: 3_000 })
  })

  test('rename artifact via context menu', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    await rightClick(mainWindow, artifactRow(mainWindow, 'schema.sql'))
    await expect(mainWindow.getByRole('menuitem', { name: 'Rename' })).toBeVisible({
      timeout: 3_000
    })
    await mainWindow.getByRole('menuitem', { name: 'Rename' }).click()
    await expect(renameInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await renameInput(mainWindow).fill('schema.json')
    await renameInput(mainWindow).press('Enter')
    await expect(artifactRow(mainWindow, 'schema.json')).toBeVisible({ timeout: 3_000 })
    await expect(artifactRow(mainWindow, 'schema.sql')).not.toBeVisible({ timeout: 2_000 })
  })

  test('delete artifact via context menu', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    await rightClick(mainWindow, artifactRow(mainWindow, 'schema.json'))
    await expect(mainWindow.getByRole('menuitem', { name: 'Delete' })).toBeVisible({
      timeout: 3_000
    })
    await mainWindow.getByRole('menuitem', { name: 'Delete' }).click()
    await expect(artifactRow(mainWindow, 'schema.json')).not.toBeVisible({ timeout: 3_000 })
  })

  // --- Group 3: Folder CRUD ---

  test('create folder via header button', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    await artifactsPanel(mainWindow).locator('[data-testid="artifacts-folder-btn"]').click()
    await expect(createInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await createInput(mainWindow).fill('designs')
    await createInput(mainWindow).press('Enter')
    await expect(folderRow(mainWindow, 'designs')).toBeVisible({ timeout: 3_000 })
  })

  test('create folder via root context menu', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    await rightClick(mainWindow, sidebar(mainWindow))
    await expect(mainWindow.getByRole('menuitem', { name: 'New Folder' })).toBeVisible({
      timeout: 3_000
    })
    await mainWindow.getByRole('menuitem', { name: 'New Folder' }).first().click()
    await expect(createInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await createInput(mainWindow).fill('docs')
    await createInput(mainWindow).press('Enter')
    await expect(folderRow(mainWindow, 'docs')).toBeVisible({ timeout: 3_000 })
  })

  test('create artifact inside folder via context menu', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    await rightClick(mainWindow, folderRow(mainWindow, 'designs'))
    await expect(mainWindow.getByRole('menuitem', { name: 'New Artifact' })).toBeVisible({
      timeout: 3_000
    })
    await mainWindow.getByRole('menuitem', { name: 'New Artifact' }).first().click()
    await expect(createInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await createInput(mainWindow).fill('mockup.svg')
    await createInput(mainWindow).press('Enter')
    await expect(artifactRow(mainWindow, 'mockup.svg')).toBeVisible({ timeout: 3_000 })
  })

  test('create subfolder via folder context menu', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    await rightClick(mainWindow, folderRow(mainWindow, 'designs'))
    await expect(mainWindow.getByRole('menuitem', { name: 'New Folder' })).toBeVisible({
      timeout: 3_000
    })
    await mainWindow.getByRole('menuitem', { name: 'New Folder' }).first().click()
    await expect(createInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await createInput(mainWindow).fill('icons')
    await createInput(mainWindow).press('Enter')
    await expect(folderRow(mainWindow, 'icons')).toBeVisible({ timeout: 3_000 })
  })

  test('rename folder via context menu', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    await rightClick(mainWindow, folderRow(mainWindow, 'docs'))
    await expect(mainWindow.getByRole('menuitem', { name: 'Rename' })).toBeVisible({
      timeout: 3_000
    })
    await mainWindow.getByRole('menuitem', { name: 'Rename' }).click()
    await expect(renameInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await renameInput(mainWindow).fill('documentation')
    await renameInput(mainWindow).press('Enter')
    await expect(folderRow(mainWindow, 'documentation')).toBeVisible({ timeout: 3_000 })
    await expect(folderRow(mainWindow, 'docs')).not.toBeVisible({ timeout: 2_000 })
  })

  test('delete folder moves artifacts to root', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)

    // Self-contained setup: create a fresh folder + artifact inside it.
    const s = seed(mainWindow)
    const folder = await s.createArtifactFolder({ taskId, name: 'to-delete' })
    await s.createArtifact({ taskId, title: 'guide.md', folderId: folder.id, content: '' })
    await s.refreshData()
    await expect(folderRow(mainWindow, 'to-delete')).toBeVisible({ timeout: 5_000 })

    // Delete the folder via context menu
    await rightClick(mainWindow, folderRow(mainWindow, 'to-delete'))
    await mainWindow.getByRole('menuitem', { name: 'Delete' }).first().click()

    // Folder gone, artifact moves to root.
    await expect(folderRow(mainWindow, 'to-delete')).not.toBeVisible({ timeout: 3_000 })
    await expect(artifactRow(mainWindow, 'guide.md')).toBeVisible({ timeout: 3_000 })
  })

  // --- Group 4: Context menu items ---

  test('artifact context menu has correct items', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    if (
      !(await artifactRow(mainWindow, 'notes.md')
        .isVisible({ timeout: 500 })
        .catch(() => false))
    ) {
      await seed(mainWindow).createArtifact({ taskId, title: 'notes.md', content: '' })
      await seed(mainWindow).refreshData()
    }
    await rightClick(mainWindow, artifactRow(mainWindow, 'notes.md'))

    await expect(mainWindow.getByRole('menuitem', { name: 'Rename' })).toBeVisible({
      timeout: 3_000
    })
    await expect(mainWindow.getByRole('menuitem', { name: 'Copy Path' })).toBeVisible()
    await expect(mainWindow.getByRole('menuitem', { name: 'Delete' })).toBeVisible()

    // Close menu
    await mainWindow.keyboard.press('Escape')
  })

  test('folder context menu has correct items', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    if (
      !(await folderRow(mainWindow, 'designs')
        .isVisible({ timeout: 500 })
        .catch(() => false))
    ) {
      await seed(mainWindow).createArtifactFolder({ taskId, name: 'designs' })
      await seed(mainWindow).refreshData()
    }
    await rightClick(mainWindow, folderRow(mainWindow, 'designs'))

    await expect(mainWindow.getByRole('menuitem', { name: 'New Artifact' })).toBeVisible({
      timeout: 3_000
    })
    await expect(mainWindow.getByRole('menuitem', { name: 'New Folder' })).toBeVisible()
    await expect(mainWindow.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
    await expect(mainWindow.getByRole('menuitem', { name: 'Delete' })).toBeVisible()

    await mainWindow.keyboard.press('Escape')
  })

  test('root context menu has New Artifact and New Folder', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    // Right-click on empty space in sidebar
    await sidebar(mainWindow).click({ button: 'right', position: { x: 10, y: 5 } })

    await expect(mainWindow.getByRole('menuitem', { name: 'New Artifact' })).toBeVisible({
      timeout: 3_000
    })
    await expect(mainWindow.getByRole('menuitem', { name: 'New Folder' })).toBeVisible()

    await mainWindow.keyboard.press('Escape')
  })

  // --- Group 5: Content editing ---

  test('view mode toggle works for markdown', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    // Ensure notes.md exists (this spec runs sequentially but be resilient).
    if (
      !(await artifactRow(mainWindow, 'notes.md')
        .isVisible({ timeout: 500 })
        .catch(() => false))
    ) {
      await seed(mainWindow).createArtifact({ taskId, title: 'notes.md', content: '# notes\n' })
      await seed(mainWindow).refreshData()
    }
    await artifactRow(mainWindow, 'notes.md').click()

    // Should be in preview mode (WYSIWYG) by default
    await expect(artifactsPanel(mainWindow).locator('.ProseMirror').first()).toBeVisible({
      timeout: 3_000
    })

    // Click split mode
    const splitBtn = artifactsPanel(mainWindow)
      .locator('button')
      .filter({ hasText: 'Split' })
      .first()
    if (await splitBtn.isVisible().catch(() => false)) {
      await splitBtn.click()
      // Should see both textarea and preview
      await expect(artifactsPanel(mainWindow).locator('textarea').first()).toBeVisible({
        timeout: 3_000
      })
    }
  })

  // --- Group 6: Empty folder renders ---

  test('empty folder is visible in tree', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    // Self-contained: create an empty folder and verify it renders in the tree.
    const s = seed(mainWindow)
    await s.createArtifactFolder({ taskId, name: 'empty-folder-test' })
    await s.refreshData()
    await expect(folderRow(mainWindow, 'empty-folder-test')).toBeVisible({ timeout: 3_000 })
  })

  // --- Group 7: Inline create escape cancels ---

  test('pressing Escape cancels inline creation', async ({ mainWindow }) => {
    await openArtifactsPanel(mainWindow)
    await artifactsPanel(mainWindow).locator('[data-testid="artifacts-new-btn"]').click()
    await expect(createInput(mainWindow)).toBeVisible({ timeout: 3_000 })
    await createInput(mainWindow).press('Escape')
    await expect(createInput(mainWindow)).not.toBeVisible({ timeout: 2_000 })
  })

  // --- Group 8: Seed-based tests ---

  test('seeded artifacts appear in panel', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    await s.createArtifact({ taskId, title: 'seeded.txt', content: 'hello world' })
    await s.refreshData()

    await openArtifactsPanel(mainWindow)
    await expect(artifactRow(mainWindow, 'seeded.txt')).toBeVisible({ timeout: 5_000 })
  })

  test('seeded folder with artifact renders correctly', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const folder = await s.createArtifactFolder({ taskId, name: 'seeded-folder' })
    await s.createArtifact({ taskId, title: 'nested.md', folderId: folder.id })
    await s.refreshData()

    await openArtifactsPanel(mainWindow)
    await expect(folderRow(mainWindow, 'seeded-folder')).toBeVisible({ timeout: 5_000 })
    // Folders render collapsed by default — click to expand so nested artifact appears.
    await folderRow(mainWindow, 'seeded-folder').click()
    await expect(artifactRow(mainWindow, 'nested.md')).toBeVisible({ timeout: 3_000 })
  })

  // --- Group 9: External-sync banner + caret preservation ---

  test('conflict banner is absolute-positioned and does not shift editor', async ({
    mainWindow
  }) => {
    const s = seed(mainWindow)
    // Use a code-mode extension so CodeMirror is the only editor — preview/split toggle isn't on the path.
    const artifact = await s.createArtifact({
      taskId,
      title: 'sync-banner.ts',
      content: 'initial\n'
    })
    await s.refreshData()

    await openArtifactsPanel(mainWindow)
    await artifactRow(mainWindow, 'sync-banner.ts').click()

    const editor = artifactsPanel(mainWindow).locator('.cm-editor').first()
    await expect(editor).toBeVisible({ timeout: 5_000 })

    // Resolve disk path for external write
    const filePath = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().artifacts.getFilePath.query({ id }),
      artifact.id
    )
    expect(filePath).toBeTruthy()

    // Dirty the buffer
    await editor.locator('.cm-content').click()
    await mainWindow.keyboard.type('local edits')

    const before = await editor.boundingBox()
    expect(before).toBeTruthy()

    // External write to provoke mtime mismatch → conflict banner
    fs.writeFileSync(filePath as string, 'external write\n')

    const banner = artifactsPanel(mainWindow).locator('[data-testid="artifact-conflict-banner"]')
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
    await expect(banner.locator('[data-testid="artifact-conflict-reload"]')).toBeVisible()
    await expect(banner.locator('[data-testid="artifact-conflict-keep"]')).toBeVisible()

    // Cleanup: keep-mine to clear conflict before next test
    await banner.locator('[data-testid="artifact-conflict-keep"]').click()
    await expect(banner).not.toBeVisible({ timeout: 3_000 })
  })

  test('caret survives save round-trip in code editor', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    // Use a code-mode extension (.ts) so CodeMirror renders directly (no ProseMirror preview).
    await s.createArtifact({ taskId, title: 'caret-test.ts', content: '' })
    await s.refreshData()

    await openArtifactsPanel(mainWindow)
    await artifactRow(mainWindow, 'caret-test.ts').click()

    const editor = artifactsPanel(mainWindow).locator('.cm-editor').first()
    await expect(editor).toBeVisible({ timeout: 5_000 })

    const cmContent = editor.locator('.cm-content')
    await cmContent.click()

    // Type, wait past 500ms save debounce, type more. Caret must remain at end →
    // final doc string is in the order typed, not reset/reordered by replaceAll.
    await mainWindow.keyboard.type('abc')
    await mainWindow.waitForTimeout(800)
    await mainWindow.keyboard.type('def')

    await expect
      .poll(async () => cmContent.evaluate((el) => el.textContent ?? ''), { timeout: 3_000 })
      .toBe('abcdef')
  })
})
