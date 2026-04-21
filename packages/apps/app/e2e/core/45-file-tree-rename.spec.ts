import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import fs from 'fs'
import path from 'path'

test.describe('File tree rename', () => {
  let projectAbbrev: string

  const editorPanel = (page: import('@playwright/test').Page) =>
    page.locator('[data-panel-id="editor"]:visible').filter({ hasText: 'Files' })

  const treeFile = (page: import('@playwright/test').Page, name: string) =>
    editorPanel(page).locator(`button.w-full:has-text("${name}")`).first()

  const renameInput = (page: import('@playwright/test').Page) =>
    editorPanel(page).locator('[data-testid="rename-input"]')

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)

    if (fs.existsSync(path.join(TEST_PROJECT_PATH, 'will-not-save.ts'))) {
      fs.unlinkSync(path.join(TEST_PROJECT_PATH, 'will-not-save.ts'))
    }
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, 'renameme.ts'), 'export const x = 1\n')
    fs.mkdirSync(path.join(TEST_PROJECT_PATH, 'oldname', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, 'oldname', 'other.ts'), 'export const o = 1\n')
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, 'oldname', 'sub', 'inner.ts'), 'export const y = 2\n')

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Rename Test', color: '#6366f1', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    await s.createTask({ projectId: p.id, title: 'Rename test task', status: 'todo' })
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('Rename test task').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('Rename test task').first().click()
    await expect(mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({ timeout: 5_000 })

    await mainWindow.keyboard.press('Meta+e')
    await expect(editorPanel(mainWindow).getByText('Files')).toBeVisible({ timeout: 5_000 })
  })

  test('file rename via context menu + Enter commits on disk', async ({ mainWindow }) => {
    await expect(treeFile(mainWindow, 'renameme.ts')).toBeVisible({ timeout: 5_000 })
    await treeFile(mainWindow, 'renameme.ts').click({ button: 'right' })
    await expect(mainWindow.getByRole('menuitem', { name: 'Rename' })).toBeVisible({ timeout: 3_000 })
    await mainWindow.getByRole('menuitem', { name: 'Rename' }).click()

    const input = renameInput(mainWindow)
    await expect(input).toBeVisible({ timeout: 3_000 })
    await input.fill('renamed.ts')
    await input.press('Enter')

    await expect(input).not.toBeVisible({ timeout: 3_000 })
    expect(fs.existsSync(path.join(TEST_PROJECT_PATH, 'renamed.ts'))).toBe(true)
    expect(fs.existsSync(path.join(TEST_PROJECT_PATH, 'renameme.ts'))).toBe(false)
    await expect(treeFile(mainWindow, 'renamed.ts')).toBeVisible({ timeout: 5_000 })

    fs.renameSync(path.join(TEST_PROJECT_PATH, 'renamed.ts'), path.join(TEST_PROJECT_PATH, 'renameme.ts'))
  })

  test('folder rename via context menu + Enter commits on disk', async ({ mainWindow }) => {
    await expect(treeFile(mainWindow, 'oldname')).toBeVisible({ timeout: 5_000 })
    await treeFile(mainWindow, 'oldname').click({ button: 'right' })
    await mainWindow.getByRole('menuitem', { name: 'Rename' }).click()

    const input = renameInput(mainWindow)
    await expect(input).toBeVisible({ timeout: 3_000 })
    await input.fill('newname')
    await input.press('Enter')

    await expect(input).not.toBeVisible({ timeout: 3_000 })
    expect(fs.existsSync(path.join(TEST_PROJECT_PATH, 'newname'))).toBe(true)
    expect(fs.existsSync(path.join(TEST_PROJECT_PATH, 'oldname'))).toBe(false)
    await expect(treeFile(mainWindow, 'newname')).toBeVisible({ timeout: 5_000 })

    fs.renameSync(path.join(TEST_PROJECT_PATH, 'newname'), path.join(TEST_PROJECT_PATH, 'oldname'))
  })

  test('folder rename preserves expandedFolders for renamed folder + descendants', async ({ mainWindow }) => {
    await expect(treeFile(mainWindow, 'oldname')).toBeVisible({ timeout: 5_000 })

    await treeFile(mainWindow, 'oldname').click()
    await expect(treeFile(mainWindow, 'sub')).toBeVisible({ timeout: 5_000 })

    await treeFile(mainWindow, 'sub').click()
    await expect(treeFile(mainWindow, 'inner.ts')).toBeVisible({ timeout: 5_000 })

    await treeFile(mainWindow, 'oldname').click({ button: 'right' })
    await mainWindow.getByRole('menuitem', { name: 'Rename' }).click()

    const input = renameInput(mainWindow)
    await expect(input).toBeVisible({ timeout: 3_000 })
    await input.fill('newname')
    await input.press('Enter')

    await expect(input).not.toBeVisible({ timeout: 3_000 })
    await expect(treeFile(mainWindow, 'newname')).toBeVisible({ timeout: 5_000 })

    await expect(treeFile(mainWindow, 'sub')).toBeVisible({ timeout: 5_000 })
    await expect(treeFile(mainWindow, 'inner.ts')).toBeVisible({ timeout: 5_000 })

    fs.renameSync(path.join(TEST_PROJECT_PATH, 'newname'), path.join(TEST_PROJECT_PATH, 'oldname'))
  })

  test('Escape cancels rename without committing and without blur double-invoke', async ({ mainWindow }) => {
    await expect(treeFile(mainWindow, 'renameme.ts')).toBeVisible({ timeout: 5_000 })
    await treeFile(mainWindow, 'renameme.ts').click({ button: 'right' })
    await mainWindow.getByRole('menuitem', { name: 'Rename' }).click()

    const input = renameInput(mainWindow)
    await expect(input).toBeVisible({ timeout: 3_000 })
    await input.fill('will-not-save.ts')
    await input.press('Escape')

    await expect(input).not.toBeVisible({ timeout: 3_000 })
    expect(fs.existsSync(path.join(TEST_PROJECT_PATH, 'will-not-save.ts'))).toBe(false)
    expect(fs.existsSync(path.join(TEST_PROJECT_PATH, 'renameme.ts'))).toBe(true)
  })
})
