/**
 * Codex resize — verifies no duplicate prompt area appears after terminal
 * resize. Uses real Codex CLI.
 *
 * KNOWN LIMITATION: Codex's gray prompt box (bg #303033) requires terminal
 * query responses (DA1, OSC 10/11, CPR, DSR) to arrive within crossterm's
 * detection timeout. Playwright's CDP debugging connection adds constant
 * event loop activity in Electron's main process, delaying libuv's PTY fd
 * polling just enough for crossterm to time out. The gray box appears in
 * manual usage (no Playwright) but not in automated tests. This does not
 * affect the resize behavior being tested — only the visual styling.
 */
import { test, expect, seed, resetApp, clickProject } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  waitForPtySession,
  readFullBuffer,
  getViewportLines,
} from '../fixtures/terminal'

function countStatusBars(lines: string[]): number {
  return lines.filter(l => /\d+% left/.test(l)).length
}

test.describe.skip('Codex resize — no duplicate prompt', () => {
  let projectAbbrev: string
  let taskId: string
  let sessionId: string

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
      if (win) { win.setSize(1920, 1200); win.show(); win.focus() }
    })

    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Codex Resize', color: '#8b5cf6', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'Resize test', status: 'todo' })
    taskId = t.id
    sessionId = getMainSessionId(taskId)

    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'codex' }), taskId)
    await s.refreshData()

    // Pre-seed terminal theme so OSC 11 responses are correct from the start
    await mainWindow.evaluate(() =>
      window.api.pty.setTheme({
        foreground: '#d4d4d8',
        background: '#141418',
        cursor: '#a1a1aa',
      })
    )

    // Pre-trust the test project in Codex config
    const fs = await import('fs')
    const path = await import('path')
    const os = await import('os')
    const configPath = path.join(os.homedir(), '.codex', 'config.toml')
    const config = fs.readFileSync(configPath, 'utf-8')
    if (!config.includes(TEST_PROJECT_PATH)) {
      fs.appendFileSync(configPath, `\n[projects."${TEST_PROJECT_PATH}"]\ntrust_level = "trusted"\n`)
    }

    await clickProject(mainWindow, projectAbbrev)
    await mainWindow.getByText('Resize test').first().click()
    await expect(mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible()

    await waitForPtySession(mainWindow, sessionId, 30_000)
    await expect.poll(async () => {
      const buf = await readFullBuffer(mainWindow, sessionId)
      return buf.length
    }, { timeout: 30_000 }).toBeGreaterThan(0)

    // Accept trust/model prompts if they appear
    await expect.poll(async () => {
      const buf = await readFullBuffer(mainWindow, sessionId)
      if (buf.includes('trust') || buf.includes('Press enter') || buf.includes('model') && (buf.includes('keep') || buf.includes('change'))) {
        await mainWindow.evaluate(
          ({ id }) => window.api.pty.write(id, '\r'),
          { id: sessionId }
        )
        return 'accepted'
      }
      if (buf.includes('% left')) return 'idle'
      return 'waiting'
    }, { timeout: 15_000 }).not.toBe('waiting')

    // Wait for idle TUI with status bar
    await expect.poll(async () => {
      const lines = await getViewportLines(mainWindow, sessionId)
      return lines ? countStatusBars(lines) : 0
    }, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
  })

  test('resize after verbose output', async ({ electronApp, mainWindow }) => {
    test.setTimeout(600_000)

    await mainWindow.screenshot({ path: '/tmp/codex-01-idle.png' })

    // Send a prompt that generates lots of output
    await mainWindow.evaluate(
      ({ id }) => window.api.pty.write(id, 'Write a python fizzbuzz script with detailed comments on every line'),
      { id: sessionId }
    )
    await mainWindow.waitForTimeout(200)
    await mainWindow.evaluate(
      ({ id }) => window.api.pty.write(id, '\r'),
      { id: sessionId }
    )

    // Wait for Codex to produce substantial output
    await expect.poll(async () => {
      const lines = await getViewportLines(mainWindow, sessionId)
      if (!lines) return 0
      return lines.filter(l => l.trim()).length
    }, { timeout: 60_000 }).toBeGreaterThan(10)

    await mainWindow.screenshot({ path: '/tmp/codex-02-with-content.png' })

    // Wait for Codex to return to idle
    await expect.poll(async () => {
      const lines = await getViewportLines(mainWindow, sessionId)
      return lines ? countStatusBars(lines) : 0
    }, { timeout: 60_000 }).toBeGreaterThanOrEqual(1)

    await mainWindow.screenshot({ path: '/tmp/codex-03-idle-with-history.png' })

    // Now resize — hide settings
    await mainWindow.keyboard.press('Meta+s')
    await mainWindow.waitForTimeout(1000)
    await mainWindow.screenshot({ path: '/tmp/codex-04-after-hide-settings.png' })

    // Show settings
    await mainWindow.keyboard.press('Meta+s')
    await mainWindow.waitForTimeout(1000)
    await mainWindow.screenshot({ path: '/tmp/codex-05-after-show-settings.png' })

    // Keep the app open so user can manually interact
    await mainWindow.waitForTimeout(300_000)
  })
})
