import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

/** Locate a home panel toggle button by label */
const homePanelBtn = (page: import('@playwright/test').Page, label: string) =>
  page.locator('.bg-surface-2.rounded-lg').filter({ has: page.locator(`button:has-text("Kanban")`) }).locator(`button:has-text("${label}")`)

test.describe('Home panel persistence', () => {
  let abbrevA: string
  let abbrevB: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const pA = await s.createProject({ name: 'Alfa Panel', color: '#3b82f6', path: TEST_PROJECT_PATH })
    const pB = await s.createProject({ name: 'Bravo Panel', color: '#ef4444', path: TEST_PROJECT_PATH })
    abbrevA = pA.name.slice(0, 2).toUpperCase()
    abbrevB = pB.name.slice(0, 2).toUpperCase()
    await s.createTask({ projectId: pA.id, title: 'HP task A', status: 'todo' })
    await s.createTask({ projectId: pB.id, title: 'HP task B', status: 'todo' })
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, abbrevA)
    await expect(mainWindow.getByText('HP task A').first()).toBeVisible({ timeout: 5_000 })
  })

  test('home panel visibility persists across reload', async ({ mainWindow }) => {
    // Git panel should be off by default
    await expect(homePanelBtn(mainWindow, 'Git')).not.toHaveClass(/(?:^|\s)bg-muted(?:\s|$)/)

    // Toggle git on
    await homePanelBtn(mainWindow, 'Git').click()
    await expect(homePanelBtn(mainWindow, 'Git')).toHaveClass(/bg-muted/)

    // Wait for debounce save + reload
    await mainWindow.waitForTimeout(800)
    await mainWindow.reload({ waitUntil: 'domcontentloaded' })
    await mainWindow.waitForSelector('#root', { timeout: 10_000 })

    // Git panel should still be active after reload
    await expect(homePanelBtn(mainWindow, 'Git')).toHaveClass(/bg-muted/, { timeout: 5_000 })
  })

  test('home panel visibility is per-project', async ({ mainWindow }) => {
    // Project A has git on (from previous test)
    await expect(homePanelBtn(mainWindow, 'Git')).toHaveClass(/bg-muted/)

    // Switch to project B — git should be off (default)
    await clickProject(mainWindow, abbrevB)
    await expect(mainWindow.getByText('HP task B').first()).toBeVisible({ timeout: 5_000 })
    await expect(homePanelBtn(mainWindow, 'Git')).not.toHaveClass(/(?:^|\s)bg-muted(?:\s|$)/)

    // Switch back to project A — git should still be on
    await clickProject(mainWindow, abbrevA)
    await expect(mainWindow.getByText('HP task A').first()).toBeVisible({ timeout: 5_000 })
    await expect(homePanelBtn(mainWindow, 'Git')).toHaveClass(/bg-muted/)
  })

  test('git sub-tab persists across reload', async ({ mainWindow }) => {
    // Git panel should be open (from earlier tests)
    await expect(homePanelBtn(mainWindow, 'Git')).toHaveClass(/bg-muted/)

    // Click the "Diff" tab inside the git panel
    const diffTab = mainWindow.getByRole('button', { name: 'Diff' }).first()
    await expect(diffTab).toBeVisible({ timeout: 5_000 })
    await diffTab.click()

    // Wait for debounce save + reload
    await mainWindow.waitForTimeout(800)
    await mainWindow.reload({ waitUntil: 'domcontentloaded' })
    await mainWindow.waitForSelector('#root', { timeout: 10_000 })

    // Git panel should be open and Diff tab should be active
    await expect(homePanelBtn(mainWindow, 'Git')).toHaveClass(/bg-muted/, { timeout: 5_000 })
    // Active tab has distinct styling — check it's not "General" that's active
    const diffTabAfter = mainWindow.getByRole('button', { name: 'Diff' }).first()
    await expect(diffTabAfter).toBeVisible({ timeout: 5_000 })
    // TabButton uses shadow-sm for active state
    await expect(diffTabAfter).toHaveClass(/shadow-sm/)
  })
})
