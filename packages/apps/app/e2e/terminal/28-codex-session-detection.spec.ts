import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { switchTerminalMode, openTaskTerminal } from '../fixtures/terminal'

/**
 * Tests the session ID banner system across all provider types:
 * - Codex/Gemini: detect banner with command button
 * - Cursor/OpenCode: unavailable banner (closable)
 * - Claude Code/Terminal: no banner
 */
test.describe('Session ID banners', () => {
  let projectAbbrev: string
  let codexTaskId: string
  let geminiTaskId: string
  let cursorTaskId: string
  let opencodeTaskId: string
  let claudeTaskId: string

  const detectedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const sessionBanner = (page: import('@playwright/test').Page) =>
    page.getByText('Session not saved').last()

  // Robustly open a banner task and wait for its banner. A preceding detect test
  // persists a conversation id → notifyRenderer → board refetch; that churn can (a)
  // detach the target card between the visibility check and the click so the click is
  // lost, or (b) leave a prior task TAB active so the board isn't the visible view and
  // the card stays hidden. A fixed settle (waitForTimeout) can't cover an arbitrarily
  // timed refetch, so this races deterministically right after the gemini detect test
  // (cursor is the victim). Fix: bounded retry whose TERMINAL CONDITION is the banner
  // itself (the real goal) — a lost click or wrong-tab state self-corrects on the next
  // attempt. Each attempt re-surfaces the board only when the card isn't visible and
  // waits up to 4s for the banner before retrying, so it recovers without thrashing
  // the app under contention. Mirrors openTaskViaSearch in 23-git-worktree.
  const openBannerTask = async (
    page: import('@playwright/test').Page,
    title: string,
    banner: import('@playwright/test').Locator
  ): Promise<void> => {
    await expect(async () => {
      const card = page.getByText(title).first()
      if (!(await card.isVisible({ timeout: 800 }).catch(() => false))) {
        // Card not on the visible board — a prior task tab is active. Surface the
        // board: activate the home tab (as in 01-smoke), then select the project.
        const homeIcon = page.locator('.lucide-house, .lucide-home').first()
        if (await homeIcon.isVisible({ timeout: 800 }).catch(() => false)) {
          await homeIcon.click({ timeout: 2_000 }).catch(() => {})
        }
        await clickProject(page, projectAbbrev)
        await expect(card).toBeVisible({ timeout: 3_000 })
      }
      await card.click().catch(() => {})
      await expect(banner).toBeVisible({ timeout: 4_000 })
    }).toPass({ timeout: 30_000 })
  }

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)
    // Mock PTY handlers so we don't need real CLIs
    await electronApp.evaluate(({ ipcMain }, sessionIdFromStatus: string) => {
      const globalState = globalThis as unknown as {
        __statusBuffers?: Record<string, string>
        __statusCommandCounts?: Record<string, number>
      }
      globalState.__statusBuffers = {}
      globalState.__statusCommandCounts = {}

      ipcMain.removeHandler('pty:create')
      ipcMain.handle('pty:create', async () => ({ success: true }))

      ipcMain.removeHandler('pty:write')
      ipcMain.handle('pty:write', async (event, sessionId: string, data: string) => {
        const buffers = globalState.__statusBuffers ?? {}
        const counts = globalState.__statusCommandCounts ?? {}
        buffers[sessionId] = (buffers[sessionId] ?? '') + data

        if (data.includes('\r') || data.includes('\n')) {
          const line = buffers[sessionId]
          if (line.includes('/status') || line.includes('/stats')) {
            counts[sessionId] = (counts[sessionId] ?? 0) + 1
            event.sender.send('pty:session-detected', sessionId, sessionIdFromStatus)
          }
          buffers[sessionId] = ''
        }

        globalState.__statusBuffers = buffers
        globalState.__statusCommandCounts = counts
        return true
      })

      ipcMain.removeHandler('pty:exists')
      ipcMain.handle('pty:exists', async () => true)
    }, detectedId)

    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Banner Tests',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const codexTask = await s.createTask({
      projectId: p.id,
      title: 'BT codex task',
      status: 'todo'
    })
    const geminiTask = await s.createTask({
      projectId: p.id,
      title: 'BT gemini task',
      status: 'todo'
    })
    const cursorTask = await s.createTask({
      projectId: p.id,
      title: 'BT cursor task',
      status: 'todo'
    })
    const opencodeTask = await s.createTask({
      projectId: p.id,
      title: 'BT opencode task',
      status: 'todo'
    })
    const claudeTask = await s.createTask({
      projectId: p.id,
      title: 'BT claude task',
      status: 'todo'
    })
    codexTaskId = codexTask.id
    geminiTaskId = geminiTask.id
    cursorTaskId = cursorTask.id
    opencodeTaskId = opencodeTask.id
    claudeTaskId = claudeTask.id

    await mainWindow.evaluate(
      ({ codex, gemini, cursor, opencode }) => {
        const c = window.getTrpcVanillaClient()
        return Promise.all([
          c.task.update.mutate({ id: codex, terminalMode: 'codex' }),
          c.task.update.mutate({ id: gemini, terminalMode: 'gemini' }),
          c.task.update.mutate({ id: cursor, terminalMode: 'cursor-agent' }),
          c.task.update.mutate({ id: opencode, terminalMode: 'opencode' })
          // claude task stays as default claude-code
        ])
      },
      { codex: codexTaskId, gemini: geminiTaskId, cursor: cursorTaskId, opencode: opencodeTaskId }
    )

    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('BT codex task').first()).toBeVisible({ timeout: 5_000 })
  })

  test.afterAll(async ({ electronApp }) => {
    // __restorePtyHandlers's remove-list is missing several channels that
    // registerPtyHandlers also binds (pty:submit, chat:list, session:list,
    // session:getState). Without these strips, re-registration trips the
    // patched-handle duplicate check and leaves pty:exists etc. half-torn-
    // down for the next describe.
    await electronApp.evaluate(({ ipcMain }) => {
      for (const ch of ['pty:submit', 'chat:list', 'session:list', 'session:getState']) {
        ipcMain.removeHandler(ch)
      }
      const restore = (globalThis as unknown as { __restorePtyHandlers?: () => void })
        .__restorePtyHandlers
      restore?.()
    })
  })

  // --- Codex: detect banner with /status ---

  test('codex: shows detect banner with /status button', async ({ mainWindow }) => {
    test.setTimeout(45_000)
    await openBannerTask(mainWindow, 'BT codex task', sessionBanner(mainWindow))
    await expect(mainWindow.getByRole('button', { name: /Run \/status/ }).last()).toBeVisible()
  })

  test('codex: clicking detect button saves session id and hides banner', async ({
    mainWindow
  }) => {
    await mainWindow
      .getByRole('button', { name: /Run \/status/ })
      .last()
      .click()

    // The side-car's codex adapter parses the session id out of /status output
    // and emits `session-detected`. No real codex CLI here, so simulate that
    // emit (the legacy host `pty:session-detected` IPC mock the old test relied
    // on was orphaned by the tRPC cutover). Drives the renderer's real
    // onSessionDetected → persist path.
    await mainWindow.evaluate(
      ({ id, cid }) =>
        window.getTrpcVanillaClient().pty.testEmitSessionDetected.mutate({
          sessionId: `${id}:${id}`,
          conversationId: cid
        }),
      { id: codexTaskId, cid: detectedId }
    )

    await expect
      .poll(async () => {
        const task = await mainWindow.evaluate((id) => window.getTrpcVanillaClient().task.get.query({ id }), codexTaskId)
        return task?.codex_conversation_id ?? null
      })
      .toBe(detectedId)

    await expect(sessionBanner(mainWindow)).not.toBeVisible()
  })

  // --- Gemini: detect banner with /stats ---

  test('gemini: shows detect banner with /stats button', async ({ mainWindow }) => {
    test.setTimeout(45_000)
    await openBannerTask(mainWindow, 'BT gemini task', sessionBanner(mainWindow))
    await expect(mainWindow.getByRole('button', { name: /Run \/stats/ }).last()).toBeVisible()
  })

  test('gemini: clicking detect button saves session id', async ({ mainWindow }) => {
    await mainWindow
      .getByRole('button', { name: /Run \/stats/ })
      .last()
      .click()

    // Simulate the side-car gemini adapter's `session-detected` emit (parsed
    // from /stats output) — no real gemini CLI here. Replaces the orphaned
    // legacy host pty:session-detected IPC mock.
    await mainWindow.evaluate(
      ({ id, cid }) =>
        window.getTrpcVanillaClient().pty.testEmitSessionDetected.mutate({
          sessionId: `${id}:${id}`,
          conversationId: cid
        }),
      { id: geminiTaskId, cid: detectedId }
    )

    await expect
      .poll(async () => {
        const task = await mainWindow.evaluate((id) => window.getTrpcVanillaClient().task.get.query({ id }), geminiTaskId)
        return task?.gemini_conversation_id ?? null
      })
      .toBe(detectedId)

    await expect(sessionBanner(mainWindow)).not.toBeVisible()
  })

  // --- Cursor Agent: unavailable banner ---

  test('cursor: shows unavailable banner (not detect banner)', async ({ mainWindow }) => {
    test.setTimeout(45_000)
    const banner = mainWindow.getByText(/Session ID detection not available/)
    await openBannerTask(mainWindow, 'BT cursor task', banner)
    await expect(mainWindow.getByText(/don't close the tab/)).toBeVisible()
    await expect(mainWindow.getByText(/Claude Code, Codex, Gemini, Qwen, Copilot/)).toBeVisible()
    // No detect button
    await expect(mainWindow.getByRole('button', { name: /Run \/status/ })).not.toBeVisible()
  })

  test('cursor: unavailable banner is closable', async ({ mainWindow }) => {
    // Continues from the previous test with the cursor task open. Wait for the
    // banner explicitly rather than clicking blind — otherwise, if it isn't yet
    // painted, the click below hangs for the full 30s test timeout instead of
    // failing fast.
    const bannerText = mainWindow.getByText(/Session ID detection not available/)
    await expect(bannerText).toBeVisible({ timeout: 5_000 })
    // Find and click the X button inside the banner
    await bannerText.locator('..').locator('button').click()

    await expect(bannerText).not.toBeVisible()
  })

  // --- OpenCode: unavailable banner ---

  test('opencode: shows unavailable banner', async ({ mainWindow }) => {
    test.setTimeout(45_000)
    const banner = mainWindow.getByText(/Session ID detection not available/)
    await openBannerTask(mainWindow, 'BT opencode task', banner)
    await expect(mainWindow.getByText(/don't close the tab/)).toBeVisible()
  })

  test('opencode: unavailable banner is closable', async ({ mainWindow }) => {
    // Continues with the opencode task open; wait for the banner before clicking so a
    // not-yet-painted banner fails fast instead of hanging the 30s test timeout.
    const bannerText = mainWindow.getByText(/Session ID detection not available/)
    await expect(bannerText).toBeVisible({ timeout: 5_000 })
    await bannerText.locator('..').locator('button').click()

    await expect(bannerText).not.toBeVisible()
  })

  // --- Claude Code: no banner ---

  test('claude-code: no session banner of any kind', async ({ mainWindow }) => {
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('BT claude task').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('BT claude task').first().click()

    await expect(sessionBanner(mainWindow)).not.toBeVisible()
    await expect(mainWindow.getByText(/Session ID detection not available/)).not.toBeVisible()
  })
})
