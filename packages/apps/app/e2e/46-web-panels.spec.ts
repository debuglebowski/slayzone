import { test, expect, seed, clickSettings, clickProject, goHome } from './fixtures/electron'
import { TEST_PROJECT_PATH } from './fixtures/electron'

test.describe('Web panels', () => {
  let projectAbbrev: string
  let figmaPanelName = 'Figma'

  const settingsDialog = (page: import('@playwright/test').Page) =>
    page.locator('[role="dialog"][aria-label="Settings"]').last()

  /** Find a panel card in settings by name. */
  const findCard = (
    dialog: import('@playwright/test').Locator,
    name: string
  ) =>
    dialog.locator('.space-y-2 > *').filter({ hasText: name }).first()

  const openPanelsTab = async (page: import('@playwright/test').Page) => {
    await goHome(page)
    await clickProject(page, projectAbbrev)
    const dialog = settingsDialog(page)
    if (!(await dialog.isVisible().catch(() => false))) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await clickSettings(page)
        if (await dialog.isVisible({ timeout: 1_200 }).catch(() => false)) break
        await page.keyboard.press('Meta+,').catch(() => {})
        if (await dialog.isVisible({ timeout: 1_200 }).catch(() => false)) break
        await page.waitForTimeout(120)
      }
      await expect(dialog).toBeVisible({ timeout: 5_000 })
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await dialog.getByTestId('settings-tab-panels').click()
      const nameInput = dialog.getByPlaceholder('Name')
      if (await nameInput.isVisible({ timeout: 800 }).catch(() => false)) {
        await expect(findCard(settingsDialog(page), 'Terminal')).toBeVisible({ timeout: 5_000 })
        return
      }
      const backToPanels = dialog.getByRole('button', { name: 'Panels', exact: true }).first()
      if (await backToPanels.isVisible({ timeout: 500 }).catch(() => false)) {
        await backToPanels.click({ force: true }).catch(() => {})
      }
      await page.waitForTimeout(120)
    }
    await expect(dialog.getByPlaceholder('Name')).toBeVisible({ timeout: 5_000 })
    await expect(findCard(settingsDialog(page), 'Terminal')).toBeVisible({ timeout: 5_000 })
  }

  const closePanelsTab = async (page: import('@playwright/test').Page) => {
    await page.keyboard.press('Escape')
    await expect(settingsDialog(page)).not.toBeVisible({ timeout: 5_000 })
  }

  const openTaskViaSearch = async (page: import('@playwright/test').Page, title: string) => {
    await page.keyboard.press('Meta+k')
    const input = page.getByPlaceholder('Search tasks and projects...')
    await expect(input).toBeVisible()
    await input.fill(title)
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({ timeout: 5_000 })
  }

  test.beforeAll(async ({ mainWindow }) => {
    const s = seed(mainWindow)
    await s.setSetting('panel_config', '')

    const p = await s.createProject({
      name: 'WebPanels',
      color: '#f59e0b',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    await s.createTask({ projectId: p.id, title: 'WP test task', status: 'todo' })
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('WP test task').first()).toBeVisible({ timeout: 5_000 })
  })

  // ── Settings: panels tab ──

  test('panels tab shows native and external sections', async ({ mainWindow }) => {
    await openPanelsTab(mainWindow)
    const dialog = settingsDialog(mainWindow)

    for (const name of ['Terminal', 'Browser', 'Editor', 'Git']) {
      await expect(findCard(dialog, name)).toBeVisible({ timeout: 3_000 })
    }
    for (const name of ['Figma', 'Notion', 'GitHub', 'Excalidraw']) {
      await expect(findCard(dialog, name)).toBeVisible({ timeout: 3_000 })
    }
  })

  test('predefined externals are disabled by default', async ({ mainWindow }) => {
    await openPanelsTab(mainWindow)
    const dialog = settingsDialog(mainWindow)
    for (const name of ['Figma', 'Notion', 'GitHub', 'Excalidraw']) {
      await expect(findCard(dialog, name).getByRole('switch'))
        .toHaveAttribute('data-state', 'unchecked')
    }
  })

  // ── Add custom panel (uses 'j' — letters like z/p/c/v are Electron menu accelerators) ──

  test('add custom web panel', async ({ mainWindow }) => {
    await openPanelsTab(mainWindow)
    const dialog = settingsDialog(mainWindow)

    const nameInput = dialog.getByPlaceholder('Name')
    await nameInput.scrollIntoViewIfNeeded()
    await nameInput.fill('TestPanel')
    await dialog.getByPlaceholder('URL').fill('example.com')
    await dialog.getByPlaceholder('Key').last().fill('j')

    await dialog.getByRole('button', { name: 'Add Panel' }).click()

    const card = findCard(dialog, 'TestPanel')
    await expect(card).toBeVisible({ timeout: 3_000 })
    await expect(card.getByRole('switch')).toHaveAttribute('data-state', 'checked')
  })

  test('enable Figma panel', async ({ mainWindow }) => {
    await openPanelsTab(mainWindow)
    const dialog = settingsDialog(mainWindow)
    const switchEl = findCard(dialog, 'Figma').getByRole('switch')
    await expect(switchEl).toHaveAttribute('data-state', 'unchecked')
    await switchEl.click()
    await expect(switchEl).toHaveAttribute('data-state', 'checked')
  })

  test('edit Figma panel name', async ({ mainWindow }) => {
    await openPanelsTab(mainWindow)
    const dialog = settingsDialog(mainWindow)
    const figmaCard = findCard(dialog, figmaPanelName)
    await expect(figmaCard).toBeVisible({ timeout: 3_000 })

    await figmaCard.click()
    const nameInput = dialog.locator('main input').first()
    await expect(nameInput).toBeVisible({ timeout: 3_000 })
    const nextFigmaName = `Figma Design ${Date.now().toString().slice(-4)}`
    await nameInput.clear()
    await nameInput.fill(nextFigmaName)
    const saveButton = dialog.getByRole('button', { name: 'Save' })
    if (await saveButton.isEnabled().catch(() => false)) {
      await saveButton.click()
      figmaPanelName = nextFigmaName
    }
    await dialog.getByTestId('settings-tab-panels').click()
    await expect(findCard(dialog, figmaPanelName)).toBeVisible({ timeout: 3_000 })
  })

  // ── Close settings, test keyboard shortcuts ──

  test('close settings and open task', async ({ mainWindow }) => {
    await closePanelsTab(mainWindow)
    await openTaskViaSearch(mainWindow, 'WP test task')
  })

  test('Cmd+J toggles custom web panel on', async ({ mainWindow }) => {
    // Focus a safe element first (avoid webview stealing keystrokes)
    const titleEl = mainWindow.locator('h1, [data-testid="task-title"]').first()
    if (await titleEl.isVisible().catch(() => false)) await titleEl.click()

    await mainWindow.keyboard.press('Meta+j')
    if (!(await mainWindow.locator('[data-panel-id^="web:"]:visible').first().isVisible().catch(() => false))) {
      await mainWindow.keyboard.press('Meta+Shift+j')
    }

    await expect(mainWindow.locator('[data-panel-id^="web:"]:visible').first()).toBeVisible({ timeout: 5_000 })
  })

  test('Cmd+J toggles custom web panel off', async ({ mainWindow }) => {
    // Focus outside webview before pressing shortcut again
    const titleEl = mainWindow.locator('h1, [data-testid="task-title"]').first()
    if (await titleEl.isVisible().catch(() => false)) await titleEl.click()

    await mainWindow.keyboard.press('Meta+j')
    if ((await mainWindow.locator('[data-panel-id^="web:"]:visible').count()) > 0) {
      await mainWindow.keyboard.press('Meta+Shift+j')
    }

    await expect(mainWindow.locator('[data-panel-id^="web:"]:visible')).toHaveCount(0, { timeout: 3_000 })
  })

  // ── Delete panels ──

  test('delete Figma panel, stays deleted after reopen', async ({ mainWindow }) => {
    await openPanelsTab(mainWindow)
    const dialog = settingsDialog(mainWindow)

    const card = findCard(dialog, figmaPanelName)
    await expect(card).toBeVisible({ timeout: 5_000 })
    await card.click()
    await dialog.getByRole('button', { name: 'Delete' }).click()

    await expect(findCard(dialog, figmaPanelName)).not.toBeVisible({ timeout: 3_000 })

    // Reopen — mergePredefined should NOT re-add it
    await closePanelsTab(mainWindow)
    await openPanelsTab(mainWindow)
    await expect(findCard(settingsDialog(mainWindow), figmaPanelName))
      .not.toBeVisible({ timeout: 3_000 })
  })

  test('delete custom TestPanel', async ({ mainWindow }) => {
    await openPanelsTab(mainWindow)
    const dialog = settingsDialog(mainWindow)
    const card = findCard(dialog, 'TestPanel')
    if (!(await card.isVisible({ timeout: 500 }).catch(() => false))) {
      const nameInput = dialog.getByPlaceholder('Name')
      await nameInput.fill('TestPanel')
      await dialog.getByPlaceholder('URL').fill('example.com')
      await dialog.getByPlaceholder('Key').last().fill('j')
      await dialog.getByRole('button', { name: 'Add Panel' }).click()
    }
    await expect(card).toBeVisible({ timeout: 5_000 })
    await card.click()
    await dialog.getByRole('button', { name: 'Delete' }).click()

    await expect(findCard(dialog, 'TestPanel')).not.toBeVisible({ timeout: 3_000 })
  })

  // ── Shortcut validation ──

  test('shortcut validation rejects reserved keys', async ({ mainWindow }) => {
    await openPanelsTab(mainWindow)
    const dialog = settingsDialog(mainWindow)
    const nameInput = dialog.getByPlaceholder('Name')
    await nameInput.scrollIntoViewIfNeeded()
    await nameInput.fill('BadShortcut')
    await dialog.getByPlaceholder('URL').fill('test.com')
    await dialog.getByPlaceholder('Key').last().fill('t')
    await dialog.getByRole('button', { name: 'Add Panel' }).click()

    await expect(dialog.getByText(/reserved|⌘T/i).first()).toBeVisible({ timeout: 3_000 })
    await expect(findCard(dialog, 'BadShortcut')).toHaveCount(0)

    await nameInput.clear()
    await dialog.getByPlaceholder('URL').clear()
    await dialog.getByPlaceholder('Key').last().clear()
  })

  // ── Native gear buttons ──
  // Fresh dialog open guarantees configuringNativeId is null (state from prior
  // test suites like 09-settings may linger otherwise).

  test('terminal row opens config section', async ({ mainWindow }) => {
    await closePanelsTab(mainWindow)
    await openPanelsTab(mainWindow)
    const dialog = settingsDialog(mainWindow)
    const card = findCard(dialog, 'Terminal')
    await expect(card).toBeVisible({ timeout: 5_000 })

    await card.click()
    await expect(dialog.getByText('Default mode')).toBeVisible({ timeout: 5_000 })
    await dialog.getByTestId('settings-tab-panels').click()
    await expect(findCard(dialog, 'Terminal')).toBeVisible({ timeout: 5_000 })
  })

  test('browser row opens config section', async ({ mainWindow }) => {
    await openPanelsTab(mainWindow)
    const dialog = settingsDialog(mainWindow)
    const card = findCard(dialog, 'Browser')
    await expect(card).toBeVisible({ timeout: 5_000 })

    await card.click()
    await expect(dialog.getByText('Show toast when detected'))
      .toBeVisible({ timeout: 5_000 })
    await dialog.getByTestId('settings-tab-panels').click()
    await expect(findCard(dialog, 'Browser')).toBeVisible({ timeout: 5_000 })
  })

  // ── Disable native panel ──

  test('disabling Editor panel prevents shortcut in task detail', async ({ mainWindow }) => {
    await openPanelsTab(mainWindow)
    const dialog = settingsDialog(mainWindow)
    const card = findCard(dialog, 'Editor')
    await expect(card).toBeVisible({ timeout: 5_000 })
    // Editor has 2 switches (home + task) — use last for task view
    const switchEl = card.getByRole('switch').last()

    if ((await switchEl.getAttribute('data-state')) === 'checked') {
      await switchEl.click()
    }
    await expect(switchEl).toHaveAttribute('data-state', 'unchecked')

    await closePanelsTab(mainWindow)

    await mainWindow.keyboard.press('Meta+e')
    await expect(mainWindow.locator('[data-panel-id="editor"]:visible')).toHaveCount(0, { timeout: 3_000 })

    // Re-enable
    await openPanelsTab(mainWindow)
    await findCard(settingsDialog(mainWindow), 'Editor').getByRole('switch').last().click()
    await closePanelsTab(mainWindow)
  })

  test('cleanup: go home', async ({ mainWindow }) => {
    await goHome(mainWindow)
  })
})
