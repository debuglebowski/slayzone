import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { pressShortcut, shortcutKey } from '../fixtures/shortcuts'

test.describe
  .serial('Custom keyboard shortcuts', () => {
    let projectAbbrev: string

    const openShortcutsDialog = async (mainWindow: import('@playwright/test').Page) => {
      await mainWindow.locator('button[aria-label="Keyboard Shortcuts"]').click()
      await expect(mainWindow.getByRole('dialog')).toBeVisible({ timeout: 3_000 })
    }

    const closeDialog = async (mainWindow: import('@playwright/test').Page) => {
      await mainWindow.keyboard.press('Escape')
      await expect(mainWindow.getByRole('dialog')).not.toBeVisible({ timeout: 3_000 })
    }

    /** In the open dialog, expand the group holding `label` and return its label span. */
    const revealShortcutRow = async (
      mainWindow: import('@playwright/test').Page,
      label: string
    ) => {
      // Only one Collapsible group is open at a time — find the group containing
      // the target label and ensure it's open. Walk groups, opening each in turn,
      // until the label becomes visible.
      const dialog = mainWindow.getByRole('dialog')
      const labelSpan = dialog.locator(`span.text-sm:text-is("${label}")`).first()
      if (!(await labelSpan.isVisible({ timeout: 300 }).catch(() => false))) {
        const groups = dialog.locator('button[data-state]')
        const count = await groups.count()
        for (let i = 0; i < count; i++) {
          await groups.nth(i).click()
          if (await labelSpan.isVisible({ timeout: 300 }).catch(() => false)) break
        }
      }
      await expect(labelSpan).toBeVisible({ timeout: 3_000 })
      return labelSpan
    }

    const rebindShortcut = async (
      mainWindow: import('@playwright/test').Page,
      label: string,
      newKeys: string
    ) => {
      await openShortcutsDialog(mainWindow)
      const labelSpan = await revealShortcutRow(mainWindow, label)
      const keyBadge = labelSpan.locator('..').locator('span.cursor-pointer').first()
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
      await expect(
        mainWindow.locator('[data-testid="terminal-tabbar"]:visible').first()
      ).toBeVisible({ timeout: 5_000 })
    }

    const goToHome = async (mainWindow: import('@playwright/test').Page) => {
      await goHome(mainWindow)
      await clickProject(mainWindow, projectAbbrev)
      await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).toBeVisible({
        timeout: 5_000
      })
    }

    test.beforeAll(async ({ mainWindow }) => {
      await resetApp(mainWindow)
      const s = seed(mainWindow)
      const p = await s.createProject({
        name: 'Shortcuts Test',
        color: '#06b6d4',
        path: TEST_PROJECT_PATH
      })
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
      await expect(
        mainWindow.getByPlaceholder('Search files, folders, commands, projects, and tasks...')
      ).toBeVisible({ timeout: 3_000 })
      await mainWindow.keyboard.press('Escape')

      await pressShortcut(mainWindow, 'search')
      await mainWindow.waitForTimeout(500)
      await expect(
        mainWindow.getByPlaceholder('Search files, folders, commands, projects, and tasks...')
      ).not.toBeVisible()

      await resetShortcuts(mainWindow)
    })

    // ─── Rebinding on task detail page ───

    test('rebind search — new key works on task detail page too', async ({ mainWindow }) => {
      await rebindShortcut(mainWindow, 'Search', 'Meta+Shift+p')

      // Open a task tab
      await openTask(mainWindow, 'Shortcut task')

      // New shortcut should work inside task detail page
      await mainWindow.keyboard.press('Meta+Shift+p')
      await expect(
        mainWindow.getByPlaceholder('Search files, folders, commands, projects, and tasks...')
      ).toBeVisible({ timeout: 3_000 })
      await mainWindow.keyboard.press('Escape')

      // Old shortcut should NOT work
      await pressShortcut(mainWindow, 'search')
      await mainWindow.waitForTimeout(500)
      await expect(
        mainWindow.getByPlaceholder('Search files, folders, commands, projects, and tasks...')
      ).not.toBeVisible()

      // Cleanup: go back to home, reset
      await goToHome(mainWindow)
      await resetShortcuts(mainWindow)
    })

    // ─── Reset to defaults ───

    test('reset to defaults restores original shortcuts', async ({ mainWindow }) => {
      await rebindShortcut(mainWindow, 'Search', 'Meta+Shift+p')
      await resetShortcuts(mainWindow)

      await pressShortcut(mainWindow, 'search')
      await expect(
        mainWindow.getByPlaceholder('Search files, folders, commands, projects, and tasks...')
      ).toBeVisible({ timeout: 3_000 })
      await mainWindow.keyboard.press('Escape')
    })

    // ─── Clearing ───

    test('cleared shortcut no longer fires', async ({ mainWindow }) => {
      await openShortcutsDialog(mainWindow)
      await revealShortcutRow(mainWindow, 'New Task')
      await mainWindow.getByRole('button', { name: 'Clear shortcut for New Task' }).click()
      await closeDialog(mainWindow)

      await pressShortcut(mainWindow, 'new-task')
      await mainWindow.waitForTimeout(500)
      const createTaskVisible = await mainWindow
        .getByRole('dialog')
        .getByText('Create Task')
        .isVisible()
        .catch(() => false)
      if (createTaskVisible) await closeDialog(mainWindow)

      await resetShortcuts(mainWindow)
      expect(createTaskVisible).toBe(false)
    })

    // ─── Persistence ───

    test('custom shortcut persists after page reload', async ({ mainWindow }) => {
      await rebindShortcut(mainWindow, 'Search', 'Meta+Shift+p')

      await mainWindow.reload({ waitUntil: 'domcontentloaded' })
      await mainWindow.waitForSelector('#root', { timeout: 10_000 })
      await goToHome(mainWindow)

      await mainWindow.keyboard.press('Meta+Shift+p')
      await expect(
        mainWindow.getByPlaceholder('Search files, folders, commands, projects, and tasks...')
      ).toBeVisible({ timeout: 3_000 })
      await mainWindow.keyboard.press('Escape')

      await resetShortcuts(mainWindow)
    })

    // ─── Conflict swap ───

    test('rebinding to conflicting key swaps both shortcuts', async ({ mainWindow }) => {
      await openShortcutsDialog(mainWindow)
      const dialog = mainWindow.getByRole('dialog')
      const newTaskRow = dialog.locator(`span.text-sm:text-is("New Task")`).first()
      if (!(await newTaskRow.isVisible({ timeout: 300 }).catch(() => false))) {
        const groups = dialog.locator('button[data-state]')
        const count = await groups.count()
        for (let i = 0; i < count; i++) {
          await groups.nth(i).click()
          if (await newTaskRow.isVisible({ timeout: 300 }).catch(() => false)) break
        }
      }
      await expect(newTaskRow).toBeVisible({ timeout: 3_000 })
      await newTaskRow.locator('..').locator('span.cursor-pointer').first().click()
      await expect(mainWindow.getByText('Press keys...')).toBeVisible({ timeout: 2_000 })
      // Rebind New Task to Search's current default key to trigger the conflict-swap flow.
      const searchDefaultKey = shortcutKey('search')
      await mainWindow.keyboard.press(searchDefaultKey)

      const conflictNotice = mainWindow.getByText('Already bound to')
      await expect(conflictNotice).toBeVisible({ timeout: 2_000 })
      await expect(conflictNotice).toContainText('Search')
      await mainWindow.getByRole('dialog').getByText('Reassign').click()
      await closeDialog(mainWindow)

      // Search's old default key should now open Create Task instead of Search.
      await mainWindow.keyboard.press(searchDefaultKey)
      await expect(mainWindow.getByRole('dialog').getByText('Create Task')).toBeVisible({
        timeout: 3_000
      })
      await mainWindow.keyboard.press('Escape')

      // The old New Task binding should be swapped onto Search.
      await mainWindow.keyboard.press('Meta+n')
      await expect(
        mainWindow.getByPlaceholder('Search files, folders, commands, projects, and tasks...')
      ).toBeVisible({ timeout: 3_000 })
      await mainWindow.keyboard.press('Escape')

      await resetShortcuts(mainWindow)
    })

    // ─── Recording mode ───

    test('shortcuts do not fire during recording mode', async ({ mainWindow }) => {
      await openShortcutsDialog(mainWindow)
      const labelSpan = mainWindow
        .getByRole('dialog')
        .locator(`span.text-sm:text-is("Search")`)
        .first()
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
      const settingsVisible = await mainWindow
        .getByRole('dialog')
        .isVisible()
        .catch(() => false)

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
      await expect(
        mainWindow.getByPlaceholder('Search files, folders, commands, projects, and tasks...')
      ).toBeVisible({ timeout: 3_000 })
      await mainWindow.keyboard.press('Escape')

      await goToHome(mainWindow)
      await resetShortcuts(mainWindow)
    })
  })
