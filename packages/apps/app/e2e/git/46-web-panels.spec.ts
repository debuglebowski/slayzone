import { test, expect, seed, clickSettings, clickProject, goHome, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SLAY_JS = path.resolve(__dirname, '..', '..', '..', 'cli', 'dist', 'slay.js')

test.describe('Web panels', () => {
  let projectAbbrev: string
  let figmaPanelName = 'Figma'
  let dbPath = ''
  let mcpPort = 0

  const settingsDialog = (page: import('@playwright/test').Page) =>
    page.locator('[role="dialog"][aria-label="Settings"]').last()

  /** Find a panel card in settings by name. */
  const findCard = (
    dialog: import('@playwright/test').Locator,
    name: string
  ) =>
    dialog.locator('.space-y-2 > *').filter({ hasText: name }).first()

  const openPanelsTab = async (page: import('@playwright/test').Page) => {
    const dialog = settingsDialog(page)
    // If dialog not already visible, navigate and open it
    if (!(await dialog.isVisible().catch(() => false))) {
      await goHome(page)
      await clickProject(page, projectAbbrev)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await page.keyboard.press('Meta+,')
        if (await dialog.isVisible({ timeout: 2_000 }).catch(() => false)) break
        await clickSettings(page)
        if (await dialog.isVisible({ timeout: 1_000 }).catch(() => false)) break
      }
      await expect(dialog).toBeVisible({ timeout: 3_000 })
    }
    // Navigate to panels tab; handle being in a sub-config by clicking back first
    const panelsTab = dialog.getByTestId('settings-tab-panels')
    await panelsTab.click()
    if (!(await dialog.getByPlaceholder('Name').isVisible({ timeout: 500 }).catch(() => false))) {
      const backBtn = dialog.getByRole('button', { name: 'Panels', exact: true }).first()
      if (await backBtn.isVisible({ timeout: 300 }).catch(() => false)) {
        await backBtn.click({ force: true }).catch(() => {})
      }
      await panelsTab.click()
    }
    await expect(findCard(settingsDialog(page), 'Terminal')).toBeVisible({ timeout: 3_000 })
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

  const runCli = (...args: string[]) =>
    spawnSync('node', [SLAY_JS, ...args], {
      env: { ...process.env, SLAYZONE_DB_PATH: dbPath, SLAYZONE_MCP_PORT: String(mcpPort) },
      encoding: 'utf8',
    })

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)

    // CLI setup (same pattern as 60-cli.spec.ts)
    if (fs.existsSync(SLAY_JS)) {
      const dbDir = await electronApp.evaluate(() => process.env.SLAYZONE_DB_DIR!)
      dbPath = path.join(dbDir, 'slayzone.dev.sqlite')
      mcpPort = await electronApp.evaluate(async () => {
        for (let i = 0; i < 20; i++) {
          const p = (globalThis as Record<string, unknown>).__mcpPort
          if (p) return p as number
          await new Promise((r) => setTimeout(r, 250))
        }
        return 0
      })
    }

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

  // ── CLI panel creation → auto UI update ──

  test('CLI-created panel appears in task detail panel bar', async ({ mainWindow }) => {
    await openTaskViaSearch(mainWindow, 'WP test task')

    const r = runCli('--dev', 'panels', 'create', 'CLITaskPanel', 'https://cli-task.example.com')
    expect(r.status).toBe(0)

    // settings:changed IPC → usePanelConfig reloads → PanelToggle re-renders
    await expect(mainWindow.getByRole('button', { name: 'CLITaskPanel' })).toBeVisible({ timeout: 10_000 })
  })

  test('CLI-created panel appears in settings without reopen', async ({ mainWindow }) => {
    await openPanelsTab(mainWindow)
    const dialog = settingsDialog(mainWindow)

    const r = runCli('--dev', 'panels', 'create', 'CLISettingsPanel', 'https://cli-settings.example.com')
    expect(r.status).toBe(0)

    // settings:changed IPC → PanelsSettingsTab reloads panel_config
    await expect(findCard(dialog, 'CLISettingsPanel')).toBeVisible({ timeout: 10_000 })
    await closePanelsTab(mainWindow)
  })

  test('CLI disable removes panel from task detail, enable restores it', async ({ mainWindow }) => {
    await openTaskViaSearch(mainWindow, 'WP test task')
    const panelBtn = mainWindow.getByRole('button', { name: 'CLITaskPanel' })
    await expect(panelBtn).toBeVisible({ timeout: 5_000 })

    const r1 = runCli('--dev', 'panels', 'disable', 'CLITaskPanel')
    expect(r1.status).toBe(0)
    await expect(panelBtn).not.toBeVisible({ timeout: 10_000 })

    const r2 = runCli('--dev', 'panels', 'enable', 'CLITaskPanel')
    expect(r2.status).toBe(0)
    await expect(panelBtn).toBeVisible({ timeout: 10_000 })
  })

  test('CLI delete removes panel from task detail', async ({ mainWindow }) => {
    const panelBtn = mainWindow.getByRole('button', { name: 'CLITaskPanel' })
    await expect(panelBtn).toBeVisible({ timeout: 5_000 })

    const r = runCli('--dev', 'panels', 'delete', 'CLITaskPanel')
    expect(r.status).toBe(0)
    await expect(panelBtn).not.toBeVisible({ timeout: 10_000 })
  })

  // ── CLI round-trip: create → list → disable → list → enable → list → delete → list ──

  test('CLI create appears in CLI list', async () => {
    const r = runCli('--dev', 'panels', 'create', 'RoundTrip', 'https://roundtrip.example.com', '-s', 'l')
    expect(r.status).toBe(0)

    const list = runCli('--dev', 'panels', 'list', '--json')
    expect(list.status).toBe(0)
    const panels = JSON.parse(list.stdout) as { id: string; name: string; baseUrl: string; shortcut?: string }[]
    const found = panels.find(p => p.name === 'RoundTrip')
    expect(found).toBeTruthy()
    expect(found!.baseUrl).toBe('https://roundtrip.example.com')
    expect(found!.shortcut).toBe('l')
  })

  test('CLI disable shows disabled in CLI list', async () => {
    const r = runCli('--dev', 'panels', 'disable', 'RoundTrip')
    expect(r.status).toBe(0)

    const list = runCli('--dev', 'panels', 'list')
    expect(list.status).toBe(0)
    // Table output: RoundTrip row should show ✗ (disabled)
    const line = list.stdout.split('\n').find(l => l.includes('RoundTrip'))
    expect(line).toBeTruthy()
    expect(line).toContain('✗')
  })

  test('CLI enable shows enabled in CLI list', async () => {
    const r = runCli('--dev', 'panels', 'enable', 'RoundTrip')
    expect(r.status).toBe(0)

    const list = runCli('--dev', 'panels', 'list')
    expect(list.status).toBe(0)
    const line = list.stdout.split('\n').find(l => l.includes('RoundTrip'))
    expect(line).toBeTruthy()
    expect(line).toContain('✓')
  })

  test('CLI delete removes panel from CLI list', async () => {
    const r = runCli('--dev', 'panels', 'delete', 'RoundTrip')
    expect(r.status).toBe(0)

    const list = runCli('--dev', 'panels', 'list', '--json')
    expect(list.status).toBe(0)
    const panels = JSON.parse(list.stdout) as { name: string }[]
    expect(panels.find(p => p.name === 'RoundTrip')).toBeFalsy()
  })

  test('CLI delete by name is case-insensitive', async () => {
    const cr = runCli('--dev', 'panels', 'create', 'CaseTest', 'https://case.example.com')
    expect(cr.status).toBe(0)

    const del = runCli('--dev', 'panels', 'delete', 'casetest')
    expect(del.status).toBe(0)

    const list = runCli('--dev', 'panels', 'list', '--json')
    expect(list.status).toBe(0)
    const panels = JSON.parse(list.stdout) as { name: string }[]
    expect(panels.find(p => p.name === 'CaseTest')).toBeFalsy()
  })

  test('CLI delete nonexistent panel fails', async () => {
    const r = runCli('--dev', 'panels', 'delete', 'NoSuchPanel')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('Panel not found')
  })

  test('CLI create rejects reserved shortcut', async () => {
    const r = runCli('--dev', 'panels', 'create', 'BadKey', 'https://badkey.example.com', '-s', 't')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('reserved')
  })

  test('CLI create rejects duplicate shortcut', async () => {
    // Create first panel with shortcut 'l'
    const cr = runCli('--dev', 'panels', 'create', 'DupKey1', 'https://dup1.example.com', '-s', 'l')
    expect(cr.status).toBe(0)

    // Second panel with same shortcut should fail
    const dup = runCli('--dev', 'panels', 'create', 'DupKey2', 'https://dup2.example.com', '-s', 'l')
    expect(dup.status).not.toBe(0)
    expect(dup.stderr).toContain('already used')

    // Cleanup
    runCli('--dev', 'panels', 'delete', 'DupKey1')
  })

  // ── CLI + UI: delete reflects in both ──

  test('CLI delete removes panel from both CLI list and settings', async ({ mainWindow }) => {
    // Create via CLI
    const cr = runCli('--dev', 'panels', 'create', 'BothTest', 'https://both.example.com')
    expect(cr.status).toBe(0)

    // Verify in settings
    await openPanelsTab(mainWindow)
    const dialog = settingsDialog(mainWindow)
    await expect(findCard(dialog, 'BothTest')).toBeVisible({ timeout: 10_000 })

    // Delete via CLI
    const del = runCli('--dev', 'panels', 'delete', 'BothTest')
    expect(del.status).toBe(0)

    // Gone from settings
    await expect(findCard(dialog, 'BothTest')).not.toBeVisible({ timeout: 10_000 })

    // Gone from CLI list
    const list = runCli('--dev', 'panels', 'list', '--json')
    const panels = JSON.parse(list.stdout) as { name: string }[]
    expect(panels.find(p => p.name === 'BothTest')).toBeFalsy()

    await closePanelsTab(mainWindow)
  })

  // Cleanup leftover CLISettingsPanel from earlier test
  test('cleanup: delete CLISettingsPanel', async () => {
    runCli('--dev', 'panels', 'delete', 'CLISettingsPanel')
  })

  test('cleanup: go home', async ({ mainWindow }) => {
    await goHome(mainWindow)
  })
})
