import { test, expect, seed, goHome, clickProject, resetApp } from './fixtures/electron'
import { TEST_PROJECT_PATH } from './fixtures/electron'
import { openTaskTerminal, switchTerminalMode, getMainSessionId } from './fixtures/terminal'

/**
 * Verifies that the correct pty:create opts are sent when resuming vs starting fresh.
 * Mocks pty:create to capture the opts object without spawning real CLIs.
 */
test.describe('Resume command opts', () => {
  let projectAbbrev: string
  let projectId: string

  /** Install pty:create mock that captures opts */
  const installMock = async (electronApp: import('electron').ElectronApplication) => {
    await electronApp.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as {
        __lastPtyCreateOpts: unknown
        __ptyCreateCount: number
      }
      g.__lastPtyCreateOpts = null
      g.__ptyCreateCount = 0

      ipcMain.removeHandler('pty:create')
      ipcMain.handle('pty:create', async (_event, opts) => {
        g.__lastPtyCreateOpts = opts
        g.__ptyCreateCount += 1
        return { success: true }
      })

      ipcMain.removeHandler('pty:exists')
      ipcMain.handle('pty:exists', async () => false)
    })
  }

  /** Read captured opts from main process */
  const getLastOpts = (electronApp: import('electron').ElectronApplication) =>
    electronApp.evaluate(() => (globalThis as unknown as { __lastPtyCreateOpts: unknown }).__lastPtyCreateOpts) as Promise<{
      sessionId: string
      conversationId?: string | null
      existingConversationId?: string | null
      mode?: string
      providerFlags?: string | null
    } | null>

  /** Reset capture state */
  const resetCapture = (electronApp: import('electron').ElectronApplication) =>
    electronApp.evaluate(() => {
      const g = globalThis as unknown as { __lastPtyCreateOpts: unknown; __ptyCreateCount: number }
      g.__lastPtyCreateOpts = null
      g.__ptyCreateCount = 0
    })

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)
    await installMock(electronApp)

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Resume Cmd', color: '#ec4899', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    projectId = p.id
    await s.refreshData()
  })

  test.afterAll(async ({ electronApp }) => {
    await electronApp.evaluate(() => {
      const restore = (globalThis as unknown as { __restorePtyHandlers?: () => void }).__restorePtyHandlers
      restore?.()
    })
  })

  // --- Fresh start: no stored conversationId ---

  test('claude-code fresh start: conversationId is UUID, no existingConversationId', async ({ electronApp, mainWindow }) => {
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'RC fresh claude', status: 'in_progress' })
    await s.refreshData()

    await resetCapture(electronApp)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC fresh claude' })

    await expect.poll(() => getLastOpts(electronApp), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(electronApp)
    expect(opts?.mode).toBe('claude-code')
    expect(opts?.existingConversationId).toBeFalsy()
    // Fresh start should generate a UUID for conversationId
    expect(opts?.conversationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  test('codex fresh start: no existingConversationId', async ({ electronApp, mainWindow }) => {
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'RC fresh codex', status: 'in_progress', terminalMode: 'codex' })
    await s.refreshData()

    await resetCapture(electronApp)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC fresh codex' })

    await expect.poll(() => getLastOpts(electronApp), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(electronApp)
    expect(opts?.mode).toBe('codex')
    expect(opts?.existingConversationId).toBeFalsy()
    // Codex initialCommand lacks {id} — no UUID should be generated
    expect(opts?.conversationId).toBeFalsy()
  })

  test('gemini fresh start: no existingConversationId, no conversationId', async ({ electronApp, mainWindow }) => {
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'RC fresh gemini', status: 'in_progress', terminalMode: 'gemini' })
    await s.refreshData()

    await resetCapture(electronApp)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC fresh gemini' })

    await expect.poll(() => getLastOpts(electronApp), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(electronApp)
    expect(opts?.mode).toBe('gemini')
    expect(opts?.existingConversationId).toBeFalsy()
  })

  // --- Resume: stored conversationId flows through ---

  test('claude-code resume: existingConversationId equals stored ID', async ({ electronApp, mainWindow }) => {
    const storedId = 'claude-resume-11111111'
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'RC resume claude', status: 'in_progress' })
    await mainWindow.evaluate(
      ({ id, cid }) => window.api.db.updateTask({
        id,
        providerConfig: { 'claude-code': { conversationId: cid } },
      }),
      { id: t.id, cid: storedId }
    )
    await s.refreshData()

    await resetCapture(electronApp)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC resume claude' })

    await expect.poll(() => getLastOpts(electronApp), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(electronApp)
    expect(opts?.mode).toBe('claude-code')
    expect(opts?.existingConversationId).toBe(storedId)
  })

  test('codex resume: existingConversationId equals stored ID', async ({ electronApp, mainWindow }) => {
    const storedId = 'codex-resume-22222222'
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'RC resume codex', status: 'in_progress', terminalMode: 'codex' })
    await mainWindow.evaluate(
      ({ id, cid }) => window.api.db.updateTask({
        id,
        providerConfig: { codex: { conversationId: cid } },
      }),
      { id: t.id, cid: storedId }
    )
    await s.refreshData()

    await resetCapture(electronApp)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC resume codex' })

    await expect.poll(() => getLastOpts(electronApp), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(electronApp)
    expect(opts?.mode).toBe('codex')
    expect(opts?.existingConversationId).toBe(storedId)
  })

  test('gemini resume: existingConversationId equals stored ID', async ({ electronApp, mainWindow }) => {
    const storedId = 'gemini-resume-33333333'
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'RC resume gemini', status: 'in_progress', terminalMode: 'gemini' })
    await mainWindow.evaluate(
      ({ id, cid }) => window.api.db.updateTask({
        id,
        providerConfig: { gemini: { conversationId: cid } },
      }),
      { id: t.id, cid: storedId }
    )
    await s.refreshData()

    await resetCapture(electronApp)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC resume gemini' })

    await expect.poll(() => getLastOpts(electronApp), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(electronApp)
    expect(opts?.mode).toBe('gemini')
    expect(opts?.existingConversationId).toBe(storedId)
  })

  test('cursor-agent resume: existingConversationId equals stored ID', async ({ electronApp, mainWindow }) => {
    const storedId = 'cursor-resume-44444444'
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'RC resume cursor', status: 'in_progress', terminalMode: 'cursor-agent' })
    await mainWindow.evaluate(
      ({ id, cid }) => window.api.db.updateTask({
        id,
        providerConfig: { 'cursor-agent': { conversationId: cid } },
      }),
      { id: t.id, cid: storedId }
    )
    await s.refreshData()

    await resetCapture(electronApp)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC resume cursor' })

    await expect.poll(() => getLastOpts(electronApp), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(electronApp)
    expect(opts?.mode).toBe('cursor-agent')
    expect(opts?.existingConversationId).toBe(storedId)
  })

  test('opencode resume: existingConversationId equals stored ID', async ({ electronApp, mainWindow }) => {
    const storedId = 'opencode-resume-55555555'
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'RC resume opencode', status: 'in_progress', terminalMode: 'opencode' })
    await mainWindow.evaluate(
      ({ id, cid }) => window.api.db.updateTask({
        id,
        providerConfig: { opencode: { conversationId: cid } },
      }),
      { id: t.id, cid: storedId }
    )
    await s.refreshData()

    await resetCapture(electronApp)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC resume opencode' })

    await expect.poll(() => getLastOpts(electronApp), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(electronApp)
    expect(opts?.mode).toBe('opencode')
    expect(opts?.existingConversationId).toBe(storedId)
  })

  test('qwen-code resume: existingConversationId equals stored ID', async ({ electronApp, mainWindow }) => {
    const storedId = 'qwen-resume-66666666'
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'RC resume qwen', status: 'in_progress', terminalMode: 'qwen-code' })
    await mainWindow.evaluate(
      ({ id, cid }) => window.api.db.updateTask({
        id,
        providerConfig: { 'qwen-code': { conversationId: cid } },
      }),
      { id: t.id, cid: storedId }
    )
    await s.refreshData()

    await resetCapture(electronApp)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC resume qwen' })

    await expect.poll(() => getLastOpts(electronApp), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(electronApp)
    expect(opts?.mode).toBe('qwen-code')
    expect(opts?.existingConversationId).toBe(storedId)
  })

  test('copilot resume: existingConversationId equals stored ID', async ({ electronApp, mainWindow }) => {
    const storedId = 'copilot-resume-77777777'
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'RC resume copilot', status: 'in_progress', terminalMode: 'copilot' })
    await mainWindow.evaluate(
      ({ id, cid }) => window.api.db.updateTask({
        id,
        providerConfig: { copilot: { conversationId: cid } },
      }),
      { id: t.id, cid: storedId }
    )
    await s.refreshData()

    await resetCapture(electronApp)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC resume copilot' })

    await expect.poll(() => getLastOpts(electronApp), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(electronApp)
    expect(opts?.mode).toBe('copilot')
    expect(opts?.existingConversationId).toBe(storedId)
  })

  // --- providerConfig (not legacy fields) feeds resume ---

  test('providerConfig update feeds resume correctly', async ({ electronApp, mainWindow }) => {
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'RC cfg path', status: 'in_progress', terminalMode: 'codex' })
    // Use providerConfig field (not legacy codexConversationId)
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: { codex: { conversationId: 'via-provider-config' } },
      }),
      { id: t.id }
    )
    await s.refreshData()

    await resetCapture(electronApp)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC cfg path' })

    await expect.poll(() => getLastOpts(electronApp), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(electronApp)
    expect(opts?.existingConversationId).toBe('via-provider-config')
  })

  // --- Flags flow through as providerFlags ---

  test('provider flags flow through in pty:create opts', async ({ electronApp, mainWindow }) => {
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'RC flags test', status: 'in_progress' })
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: { 'claude-code': { flags: '--custom-test-flag --verbose' } },
      }),
      { id: t.id }
    )
    await s.refreshData()

    await resetCapture(electronApp)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC flags test' })

    await expect.poll(() => getLastOpts(electronApp), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(electronApp)
    expect(opts?.providerFlags).toContain('--custom-test-flag')
    expect(opts?.providerFlags).toContain('--verbose')
  })
})
