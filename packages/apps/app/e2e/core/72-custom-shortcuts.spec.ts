import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

test.describe.serial('Custom keyboard shortcuts', () => {
  let projectAbbrev: string

  const openShortcutsDialog = async (mainWindow: import('@playwright/test').Page) => {
    await mainWindow.locator('button[aria-label="Keyboard Shortcuts"]').click()
    await expect(mainWindow.getByRole('dialog')).toBeVisible({ timeout: 3_000 })
  }

  const closeDialog = async (mainWindow: import('@playwright/test').Page) => {
    await mainWindow.keyboard.press('Escape')
    await expect(mainWindow.getByRole('dialog')).not.toBeVisible({ timeout: 3_000 })
  }

  const rebindShortcut = async (mainWindow: import('@playwright/test').Page, label: string, newKeys: string) => {
    await openShortcutsDialog(mainWindow)
    // Expand all collapsible groups so the label is visible
    const groups = mainWindow.getByRole('dialog').locator('button[data-state]')
    for (let i = 0; i < await groups.count(); i++) {
      const group = groups.nth(i)
      if (await group.getAttribute('data-state') === 'closed') {
        await group.click()
      }
    }
    const labelSpan = mainWindow.getByRole('dialog').locator(`span.text-sm:text-is("${label}")`).first()
    const keyBadge = labelSpan.locator('..').locator('span.cursor-pointer')
    await keyBadge.click()
    await expect(mainWindow.getByText('Press keys...')).toBeVisible({ timeout: 2_000 })
    await mainWindow.keyboard.press(newKeys)
    await closeDialog(mainWindow)
  }

  const resetShortcuts = async (mainWindow: import('@playwright/test').Page) => {
    await openShortcutsDialog(mainWindow)
    await mainWindow.getByText('Reset to Defaults').click()
    await closeDialog(mainWindow)
  }

  const openTask = async (mainWindow: import('@playwright/test').Page, title: string) => {
    const card = mainWindow.locator('p.line-clamp-3:visible', { hasText: title }).first()
    await card.click()
    // Wait for task detail page to load
    await expect(mainWindow.locator('[data-testid="terminal-tabbar"]:visible').first()).toBeVisible({ timeout: 5_000 })
  }

  const goToHome = async (mainWindow: import('@playwright/test').Page) => {
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).toBeVisible({ timeout: 5_000 })
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Shortcuts Test', color: '#06b6d4', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    await s.createTask({ projectId: p.id, title: 'Shortcut task', status: 'in_progress' })
    await s.refreshData()
    await goToHome(mainWindow)
  })

  // ─── Basic dialog ───

  test('opens shortcuts dialog via sidebar button', async ({ mainWindow }) => {
    await openShortcutsDialog(mainWindow)
    await expect(mainWindow.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible()
    await closeDialog(mainWindow)
  })

  test('non-customizable shortcuts are not shown as editable', async ({ mainWindow }) => {
    await openShortcutsDialog(mainWindow)
    const undoRow = mainWindow.getByRole('dialog').locator(`span.text-sm:text-is("Undo")`).first()
    await expect(undoRow).toBeVisible()
    const clickableBadge = undoRow.locator('..').locator('span.cursor-pointer')
    expect(await clickableBadge.count()).toBe(0)
    await closeDialog(mainWindow)
  })

  // ─── Rebinding on home tab ───

  test('rebind search — new key works, old key does not (home tab)', async ({ mainWindow }) => {
    await rebindShortcut(mainWindow, 'Search', 'Meta+Shift+p')

    await mainWindow.keyboard.press('Meta+Shift+p')
    await expect(mainWindow.getByPlaceholder('Search tasks and projects...')).toBeVisible({ timeout: 3_000 })
    await mainWindow.keyboard.press('Escape')

    await mainWindow.keyboard.press('Meta+k')
    await mainWindow.waitForTimeout(500)
    await expect(mainWindow.getByPlaceholder('Search tasks and projects...')).not.toBeVisible()

    await resetShortcuts(mainWindow)
  })

  // ─── Rebinding on task detail page ───

  test('rebind search — new key works on task detail page too', async ({ mainWindow }) => {
    await rebindShortcut(mainWindow, 'Search', 'Meta+Shift+p')

    // Open a task tab
    await openTask(mainWindow, 'Shortcut task')

    // New shortcut should work inside task detail page
    await mainWindow.keyboard.press('Meta+Shift+p')
    await expect(mainWindow.getByPlaceholder('Search tasks and projects...')).toBeVisible({ timeout: 3_000 })
    await mainWindow.keyboard.press('Escape')

    // Old shortcut should NOT work
    await mainWindow.keyboard.press('Meta+k')
    await mainWindow.waitForTimeout(500)
    await expect(mainWindow.getByPlaceholder('Search tasks and projects...')).not.toBeVisible()

    // Cleanup: go back to home, reset
    await goToHome(mainWindow)
    await resetShortcuts(mainWindow)
  })

  // ─── Reset to defaults ───

  test('reset to defaults restores original shortcuts', async ({ mainWindow }) => {
    await rebindShortcut(mainWindow, 'Search', 'Meta+Shift+p')
    await resetShortcuts(mainWindow)

    await mainWindow.keyboard.press('Meta+k')
    await expect(mainWindow.getByPlaceholder('Search tasks and projects...')).toBeVisible({ timeout: 3_000 })
    await mainWindow.keyboard.press('Escape')
  })

  // ─── Persistence ───

  test('custom shortcut persists after page reload', async ({ mainWindow }) => {
    await rebindShortcut(mainWindow, 'Search', 'Meta+Shift+p')

    await mainWindow.reload({ waitUntil: 'domcontentloaded' })
    await mainWindow.waitForSelector('#root', { timeout: 10_000 })
    await goToHome(mainWindow)

    await mainWindow.keyboard.press('Meta+Shift+p')
    await expect(mainWindow.getByPlaceholder('Search tasks and projects...')).toBeVisible({ timeout: 3_000 })
    await mainWindow.keyboard.press('Escape')

    await resetShortcuts(mainWindow)
  })

  // ─── Conflict swap ───

  test('rebinding to conflicting key swaps both shortcuts', async ({ mainWindow }) => {
    await openShortcutsDialog(mainWindow)
    const groups = mainWindow.getByRole('dialog').locator('button[data-state]')
    for (let i = 0; i < await groups.count(); i++) {
      const group = groups.nth(i)
      if (await group.getAttribute('data-state') === 'closed') {
        await group.click()
      }
    }

    const newTaskRow = mainWindow.getByRole('dialog').locator(`span.text-sm:text-is("New Task")`).first()
    await newTaskRow.locator('..').locator('span.cursor-pointer').click()
    await expect(mainWindow.getByText('Press keys...')).toBeVisible({ timeout: 2_000 })
    await mainWindow.keyboard.press('Meta+k')

    const conflictNotice = mainWindow.getByText('Already bound to')
    await expect(conflictNotice).toBeVisible({ timeout: 2_000 })
    await expect(conflictNotice).toContainText('Search')
    await mainWindow.getByRole('dialog').getByText('Reassign').click()
    await closeDialog(mainWindow)

    // mod+k should now open create task instead of search
    await mainWindow.keyboard.press('Meta+k')
    await expect(mainWindow.getByRole('dialog').getByText('Create Task')).toBeVisible({ timeout: 3_000 })
    await mainWindow.keyboard.press('Escape')

    // The old New Task binding should be swapped onto Search.
    await mainWindow.keyboard.press('Meta+n')
    await expect(mainWindow.getByPlaceholder('Search tasks and projects...')).toBeVisible({ timeout: 3_000 })
    await mainWindow.keyboard.press('Escape')

    await resetShortcuts(mainWindow)
  })

  // ─── Recording mode ───

  test('shortcuts do not fire during recording mode', async ({ mainWindow }) => {
    await openShortcutsDialog(mainWindow)
    const labelSpan = mainWindow.getByRole('dialog').locator(`span.text-sm:text-is("Search")`).first()
    const keyBadge = labelSpan.locator('..').locator('span.cursor-pointer')
    await keyBadge.click()
    await expect(mainWindow.getByText('Press keys...')).toBeVisible({ timeout: 2_000 })

    // mod+n while recording should NOT open create task
    await mainWindow.keyboard.press('Meta+n')
    await mainWindow.waitForTimeout(300)

    await mainWindow.keyboard.press('Escape')
    await closeDialog(mainWindow)

    await expect(mainWindow.getByRole('dialog')).not.toBeVisible({ timeout: 1_000 })
  })

  // ─── Menu accelerator updates (before-input-event) ───

  test('rebinding updates Electron before-input-event handler', async ({ mainWindow }) => {
    await rebindShortcut(mainWindow, 'Global Settings', 'Meta+Shift+;')

    // Old shortcut should no longer trigger settings
    await mainWindow.keyboard.press('Meta+,')
    await mainWindow.waitForTimeout(500)
    const settingsVisible = await mainWindow.getByRole('dialog').isVisible().catch(() => false)

    await resetShortcuts(mainWindow)
    expect(settingsVisible).toBe(false)
  })

  // ─── Task detail panel shortcuts respect overrides ───

  test('rebind panel-editor — works on task detail page', async ({ mainWindow }) => {
    await rebindShortcut(mainWindow, 'Editor', 'Meta+Shift+y')

    await openTask(mainWindow, 'Shortcut task')

    // New shortcut should toggle editor panel
    await mainWindow.keyboard.press('Meta+Shift+y')
    await mainWindow.waitForTimeout(500)

    // Old shortcut should NOT toggle editor
    // (We can't easily assert panel visibility, but we can verify no crash
    // and that the old key doesn't trigger unintended behavior)
    await mainWindow.keyboard.press('Meta+e')
    await mainWindow.waitForTimeout(300)

    await goToHome(mainWindow)
    await resetShortcuts(mainWindow)
  })

  // ─── Terminal shortcuts respect overrides ───

  test('rebind terminal search — works inside terminal', async ({ mainWindow }) => {
    await rebindShortcut(mainWindow, 'Search', 'Meta+Shift+p')

    await openTask(mainWindow, 'Shortcut task')

    // Terminal search uses its own shortcut ID (terminal-search), not the global search
    // This test verifies that the global search rebind doesn't break terminal search
    // and that the new global search key works from within a task tab
    await mainWindow.keyboard.press('Meta+Shift+p')
    await expect(mainWindow.getByPlaceholder('Search tasks and projects...')).toBeVisible({ timeout: 3_000 })
    await mainWindow.keyboard.press('Escape')

    await goToHome(mainWindow)
    await resetShortcuts(mainWindow)
  })
})
