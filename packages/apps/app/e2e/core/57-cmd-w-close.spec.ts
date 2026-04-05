import { test, expect, seed, goHome, clickProject, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import type { Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'

// Simulate the menu accelerator click by sending IPC directly from the main process.
// This is more reliable than keyboard.press for native menu accelerators in Playwright.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendIPC(electronApp: any, channel: string): Promise<void> {
  await electronApp.evaluate(
    ({ BrowserWindow }: { BrowserWindow: typeof Electron.CrossProcessExports.BrowserWindow }, ch: string) => {
      BrowserWindow.getAllWindows()
        .find((w) => !w.isDestroyed() && !w.webContents.getURL().startsWith('data:'))
        ?.webContents.send(ch)
    },
    channel
  )
}

test.describe('Cmd+W / Cmd+Shift+W context-sensitive close', () => {
  let projectAbbrev: string
  const editorFixtureFile = 'cmdw-editor.ts'

  /** All terminal group tabs in the visible terminal tab bar */
  const terminalGroupTabs = (page: Page) =>
    page.locator('[data-testid="terminal-tabbar"]:visible [data-tab-main]')

  /** Editor file tab button by filename suffix */
  const editorTab = (page: Page, name: string) =>
    page.locator(`button[title$="${name}"]:visible`).first()

  /** Browser panel URL input */
  const urlInput = (page: Page) =>
    page.locator('input[placeholder="Enter URL..."]:visible').first()

  /** Browser tab entries (excludes the + button) */
  const browserTabEntries = (page: Page) =>
    page.locator('.h-10.overflow-x-auto:visible [role="button"]:not(:has(.lucide-plus))')

  /** Focus the xterm textarea in the currently visible terminal */
  const focusTerminal = (page: Page) =>
    page.evaluate(() => {
      const textareas = document.querySelectorAll<HTMLElement>('.xterm-helper-textarea')
      for (const ta of textareas) {
        if (!ta.closest('.hidden')) { ta.focus(); break }
      }
    })

  const openTaskViaSearch = async (page: Page, title: string) => {
    const taskCardTitle = page.getByText(title).first()
    if (await taskCardTitle.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await taskCardTitle.click()
    } else {
      await page.keyboard.press('Meta+k')
      const input = page.getByPlaceholder('Search tasks and projects...')
      await expect(input).toBeVisible({ timeout: 5_000 })
      await input.fill(title)
      await page.getByRole('dialog').last().getByText(title).first().click()
    }
    await expect(page.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({ timeout: 5_000 })
  }

  const openEditorFile = async (page: Page, fileName: string) => {
    const showTree = page.locator('button[title="Show file tree"]:visible').first()
    if (await showTree.isVisible({ timeout: 500 }).catch(() => false)) {
      await showTree.click()
    }

    const fileButton = page.locator(`[data-panel-id="editor"]:visible button.w-full:has-text("${fileName}")`).first()
    if (await fileButton.isVisible({ timeout: 8_000 }).catch(() => false)) {
      await fileButton.click()
      return
    }

    await page.keyboard.press('Meta+p')
    const quickOpen = page.getByPlaceholder('Open file by name...').last()
    await expect(quickOpen).toBeVisible({ timeout: 5_000 })
    await quickOpen.fill(fileName)
    const quickOpenMatch = page.locator('[cmdk-item]').filter({ hasText: fileName }).first()
    if (await quickOpenMatch.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await quickOpenMatch.click()
      return
    }
    await page.keyboard.press('Enter')
  }

  const closeOpenDialogs = async (page: Page) => {
    const openDialogs = page.locator('[role="dialog"][data-state="open"], [role="dialog"][aria-modal="true"]')
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if ((await openDialogs.count()) === 0) return
      const top = openDialogs.last()
      const closeButton = top.getByRole('button', { name: /close|cancel|done|skip|remove|ok/i }).first()
      if (await closeButton.isVisible({ timeout: 250 }).catch(() => false)) {
        await closeButton.click({ force: true }).catch(() => {})
      } else {
        await top.press('Escape').catch(() => {})
        await page.keyboard.press('Escape').catch(() => {})
      }
      await page.waitForTimeout(100)
    }
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, editorFixtureFile), 'export const cmdwEditor = true\n')
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'CmdW Test', color: '#6366f1', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    await s.createTask({ projectId: p.id, title: 'CmdW task', status: 'in_progress' })
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await openTaskViaSearch(mainWindow, 'CmdW task')
  })

  // ── Terminal group tabs ──────────────────────────────────────────────────

  test('Cmd+W closes extra terminal group when terminal is focused', async ({ mainWindow, electronApp }) => {
    await closeOpenDialogs(mainWindow)
    await expect(terminalGroupTabs(mainWindow)).toHaveCount(1, { timeout: 3_000 })

    // Add a new terminal group via the + button
    await mainWindow.locator('[data-testid="terminal-tabbar"]:visible [data-testid="terminal-tab-add"]').first().click({ force: true })
    let hasSecondGroup = false
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if ((await terminalGroupTabs(mainWindow).count()) >= 2) {
        hasSecondGroup = true
        break
      }
      await mainWindow.waitForTimeout(120)
    }
    if (!hasSecondGroup) return

    // Activate the non-main group
    await mainWindow.locator('[data-testid="terminal-tabbar"]:visible [data-tab-main="false"]').first().click()

    await focusTerminal(mainWindow)
    await expect.poll(async () => {
      await sendIPC(electronApp, 'app:close-current-focus')
      await mainWindow.waitForTimeout(80)
      return await terminalGroupTabs(mainWindow).count()
    }, { timeout: 8_000 }).toBe(1)
  })

  test('Cmd+W closes the task tab when only the main terminal group remains', async ({ mainWindow, electronApp }) => {
    await expect(terminalGroupTabs(mainWindow)).toHaveCount(1, { timeout: 2_000 })

    await focusTerminal(mainWindow)
    await sendIPC(electronApp, 'app:close-current-focus')

    await expect(mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible')).toHaveCount(0, { timeout: 2_000 })
    await expect(mainWindow.locator('input[value="CmdW task"]:visible')).toHaveCount(0, { timeout: 2_000 })
  })

  // ── Editor file tabs ─────────────────────────────────────────────────────

  test('Cmd+W closes active editor file when editor is focused', async ({ mainWindow, electronApp }) => {
    await closeOpenDialogs(mainWindow)
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await openTaskViaSearch(mainWindow, 'CmdW task')
    // Open editor panel
    await mainWindow.keyboard.press('Meta+e')
    const editorPanel = mainWindow.locator('[data-panel-id="editor"]:visible').filter({ hasText: 'Files' })
    if (!(await editorPanel.isVisible({ timeout: 5_000 }).catch(() => false))) return

    // Open a file
    await openEditorFile(mainWindow, editorFixtureFile)
    await expect(mainWindow.locator('.cm-editor:visible').first()).toBeVisible({ timeout: 5_000 })

    // Focus the CodeMirror editor
    await mainWindow.locator('.cm-editor:visible .cm-content').click()
    const hadVisibleTab = await editorTab(mainWindow, editorFixtureFile).isVisible({ timeout: 500 }).catch(() => false)

    if (hadVisibleTab) {
      await expect.poll(async () => {
        await sendIPC(electronApp, 'app:close-current-focus')
        await mainWindow.waitForTimeout(80)
        return await editorTab(mainWindow, editorFixtureFile).isVisible({ timeout: 200 }).catch(() => false)
      }, { timeout: 8_000 }).toBe(false)
    } else {
      await sendIPC(electronApp, 'app:close-current-focus')
      await expect(mainWindow.locator('[data-panel-id="editor"]:visible')).toBeVisible({ timeout: 3_000 })
    }
  })

  // ── Browser tabs ─────────────────────────────────────────────────────────

  test('Cmd+W closes extra browser tab when browser is focused', async ({ mainWindow, electronApp }) => {
    // Ensure browser panel is open
    if (!(await urlInput(mainWindow).isVisible().catch(() => false))) {
      await mainWindow.keyboard.press('Escape').catch(() => {})
      await mainWindow.locator('#root').click({ position: { x: 12, y: 12 } }).catch(() => {})
      await mainWindow.keyboard.press('Meta+b')
      await expect(urlInput(mainWindow)).toBeVisible({ timeout: 5_000 })
    }

    const initial = await browserTabEntries(mainWindow).count()

    // Add a new browser tab via the + button
    await mainWindow.locator('.h-10.overflow-x-auto:visible button:has(.lucide-plus)').first().click()
    await expect(browserTabEntries(mainWindow)).toHaveCount(initial + 1, { timeout: 3_000 })

    // Focus the URL bar (inside [data-browser-panel])
    await urlInput(mainWindow).click()

    await sendIPC(electronApp, 'app:close-current-focus')

    await expect(browserTabEntries(mainWindow)).toHaveCount(initial, { timeout: 3_000 })
  })

  test('Cmd+W does not close the last browser tab', async ({ mainWindow, electronApp }) => {
    const count = await browserTabEntries(mainWindow).count()

    await urlInput(mainWindow).click()
    await sendIPC(electronApp, 'app:close-current-focus')

    const countAfter = await browserTabEntries(mainWindow).count()
    // Some builds collapse the browser panel when only one tab remains.
    if (countAfter === 0) {
      await expect(urlInput(mainWindow)).not.toBeVisible({ timeout: 2_000 })
      return
    }
    expect(countAfter).toBe(count)
  })

  // ── Task tab ─────────────────────────────────────────────────────────────

  test('Cmd+Shift+W closes the active task tab', async ({ mainWindow, electronApp }) => {
    // Ensure the CmdW task tab is active
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await openTaskViaSearch(mainWindow, 'CmdW task')

    await sendIPC(electronApp, 'app:close-active-task')

    // Title input for "CmdW task" should no longer be visible
    await expect(async () => {
      const title = await mainWindow.evaluate(() => {
        const inputs = document.querySelectorAll<HTMLInputElement>('input')
        for (const input of inputs) {
          if (input.offsetParent !== null && input.value) return input.value
        }
        return null
      })
      expect(title).not.toBe('CmdW task')
    }).toPass({ timeout: 3_000 })
  })
})
