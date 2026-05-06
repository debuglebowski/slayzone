/**
 * Consolidated terminal core behavior tests.
 * Merged from: 31-buffer-restore, 32-state-transitions, 34-mode-switch-teardown,
 *              35-tab-rename-persistence, 37-clear-buffer, 55-trailing-output
 */
import { test, expect, seed, clickProject, goHome, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal,
  readFullBuffer,
  runCommand,
  switchTerminalMode,
  waitForBufferContains,
  waitForNoPtySession,
  waitForPtySession,
  waitForPtyState,
} from '../fixtures/terminal'

// ── Buffer restore ──────────────────────────────────────────────────────────

test.describe('Terminal buffer restore', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Charlie Restore', color: '#f97316', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({ projectId: p.id, title: 'Buffer restore task', status: 'in_progress' })
    taskId = t.id

    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), taskId)
    await s.refreshData()
  })

  test('restores terminal output after navigating away and back', async ({ mainWindow }) => {
    const marker = `RESTORE_${Date.now()}`

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Buffer restore task' })

    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)
    await runCommand(mainWindow, sessionId, `echo ${marker}`)
    await waitForBufferContains(mainWindow, sessionId, marker)

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await mainWindow.getByText('Buffer restore task').first().click()
    await expect(mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible()

    await waitForPtySession(mainWindow, sessionId)
    const restoredBuffer = await readFullBuffer(mainWindow, sessionId)
    expect(restoredBuffer).toContain(marker)
  })
})

// ── State transitions ───────────────────────────────────────────────────────

test.describe('Terminal state transitions', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Delta State', color: '#eab308', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({ projectId: p.id, title: 'State transition task', status: 'in_progress' })
    taskId = t.id

    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), taskId)
    await s.refreshData()
  })

  test('reaches idle after startup and stays healthy after command execution', async ({ mainWindow }) => {
    const marker = `STATE_${Date.now()}`

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'State transition task' })

    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)

    const initialState = await mainWindow.evaluate((id) => window.api.pty.getState(id), sessionId)
    expect(['starting', 'idle']).toContain(initialState)

    await waitForPtyState(mainWindow, sessionId, 'idle')

    await runCommand(mainWindow, sessionId, `echo ${marker}`)
    await waitForBufferContains(mainWindow, sessionId, marker)

    await expect
      .poll(async () => mainWindow.evaluate((id) => window.api.pty.getState(id), sessionId))
      .toBe('idle')
  })
})

// ── Mode switch teardown ────────────────────────────────────────────────────

test.describe('Terminal mode switch teardown', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Mode Teardown', color: '#14b8a6', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({ projectId: p.id, title: 'Mode teardown task', status: 'in_progress' })
    taskId = t.id

    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), taskId)
    await s.refreshData()
  })

  test('kills previous session and issues create for the new mode', async ({ mainWindow }) => {
    const sessionId = getMainSessionId(taskId)
    const marker = `BEFORE_SWITCH_${Date.now()}`

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Mode teardown task' })
    await waitForPtySession(mainWindow, sessionId)
    await runCommand(mainWindow, sessionId, `echo ${marker}`)
    await waitForBufferContains(mainWindow, sessionId, marker)

    await switchTerminalMode(mainWindow, 'codex')

    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.terminal_mode).toBe('codex')

    await waitForPtySession(mainWindow, sessionId)
    const postSwitchBuffer = await readFullBuffer(mainWindow, sessionId)
    expect(postSwitchBuffer).not.toContain(marker)

    await switchTerminalMode(mainWindow, 'terminal')
    await waitForPtySession(mainWindow, sessionId)
  })
})

// ── Tab rename persistence ──────────────────────────────────────────────────

test.describe('Terminal tab rename persistence', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Tab Rename', color: '#3b82f6', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({ projectId: p.id, title: 'Tab rename task', status: 'todo' })
    taskId = t.id

    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), taskId)
    await s.refreshData()
  })

  test('renamed non-main tab persists in DB and after navigation', async ({ mainWindow }) => {
    const label = `Renamed ${Date.now()}`

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Tab rename task' })
    await mainWindow.locator('[data-testid="terminal-tabbar"]:visible [data-testid="terminal-tab-add"]').first().click()

    await expect
      .poll(async () => {
        const tabs = await mainWindow.evaluate((id) => window.api.tabs.list(id), taskId)
        const nonMain = tabs.find((tab: { id: string; isMain: boolean }) => !tab.isMain)
        return nonMain?.id ?? null
      })
      .not.toBeNull()

    const tabs = await mainWindow.evaluate((id) => window.api.tabs.list(id), taskId)
    const nonMainTab = tabs.find((tab: { id: string; isMain: boolean }) => !tab.isMain)
    expect(nonMainTab).toBeTruthy()
    const nonMainTabId = nonMainTab!.id

    const tab = mainWindow.getByTestId(`terminal-tab-${nonMainTabId}`)
    await tab.dblclick()
    const input = tab.locator('input')
    await expect(input).toBeVisible()
    await input.fill(label)
    await input.press('Enter')

    await expect(tab.getByText(label)).toBeVisible()

    await expect
      .poll(async () => {
        const list = await mainWindow.evaluate((id) => window.api.tabs.list(id), taskId)
        const renamed = list.find((t: { id: string }) => t.id === nonMainTabId)
        return renamed?.label ?? null
      })
      .toBe(label)

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await mainWindow.getByText('Tab rename task').first().click()
    await expect(mainWindow.locator('[data-testid="terminal-tabbar"]:visible').first()).toBeVisible()

    await expect(mainWindow.getByTestId(`terminal-tab-${nonMainTabId}`).getByText(label)).toBeVisible()
  })
})

// ── Clear buffer ────────────────────────────────────────────────────────────

test.describe('Terminal clear buffer', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Delta Clear', color: '#0ea5e9', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({ projectId: p.id, title: 'Clear buffer task', status: 'in_progress' })
    taskId = t.id

    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), taskId)
    await s.refreshData()
  })

  test('clears buffer without killing PTY', async ({ mainWindow }) => {
    const markerA = `CLEAR_A_${Date.now()}`
    const markerB = `CLEAR_B_${Date.now()}`

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Clear buffer task' })

    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)

    await runCommand(mainWindow, sessionId, `echo ${markerA}`)
    await waitForBufferContains(mainWindow, sessionId, markerA)
    // Wait for shell to be idle (prompt displayed = all PTY output flushed)
    await waitForPtyState(mainWindow, sessionId, 'idle')

    // Clear buffer and capture the seq AT clear time. Anything after this seq
    // is *post-clear* output — markerA cannot appear there regardless of any
    // late PTY redraw, eliminating the race the previous re-clear loop tried
    // to paper over.
    const cleared = await mainWindow.evaluate(
      (id) => window.api.pty.clearBuffer(id),
      sessionId
    ) as { success: boolean; clearedSeq: number | null }
    expect(cleared.success).toBe(true)
    expect(cleared.clearedSeq).not.toBeNull()
    const clearedSeq = cleared.clearedSeq as number

    await expect.poll(async () => mainWindow.evaluate((id) => window.api.pty.exists(id), sessionId)).toBe(true)

    await runCommand(mainWindow, sessionId, `echo ${markerB}`)

    const sinceClear = async () => {
      const result = await mainWindow.evaluate(
        ([id, seq]: [string, number]) => window.api.pty.getBufferSince(id, seq),
        [sessionId, clearedSeq] as [string, number]
      ) as { chunks: { data: string }[] } | null
      return result?.chunks.map((c) => c.data).join('') ?? ''
    }

    await expect.poll(sinceClear, { timeout: 10_000 }).toContain(markerB)

    const postClear = await sinceClear()
    expect(postClear).toContain(markerB)
    expect(postClear).not.toContain(markerA)
  })
})

// ── Restart via shortcut ────────────────────────────────────────────────────

test.describe('Terminal restart shortcut', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Qr Restart', color: '#a855f7', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({ projectId: p.id, title: 'Restart shortcut task', status: 'in_progress' })
    taskId = t.id

    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), taskId)
    await s.refreshData()
  })

  test('Cmd+Alt+R kills PTY and spawns a fresh session', async ({ mainWindow }) => {
    const marker = `PRE_RESTART_${Date.now()}`

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Restart shortcut task' })

    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)
    await runCommand(mainWindow, sessionId, `echo ${marker}`)
    await waitForBufferContains(mainWindow, sessionId, marker)
    await waitForPtyState(mainWindow, sessionId, 'idle')

    // Focus terminal so shortcut reaches the handler
    await mainWindow.evaluate(() => {
      const textareas = document.querySelectorAll('.xterm-helper-textarea')
      const target = textareas[textareas.length - 1] as HTMLTextAreaElement | null
      target?.focus()
    })

    await mainWindow.keyboard.press('Meta+Alt+r')

    // PTY should respawn — wait for a fresh session
    await waitForPtySession(mainWindow, sessionId)
    await waitForPtyState(mainWindow, sessionId, 'idle')

    // Old buffer content should be gone. Allow a beat for the remount to flush
    // the old serialized buffer; assertion polls the in-process buffer.
    await expect.poll(
      async () => (await readFullBuffer(mainWindow, sessionId)).includes(marker),
      { timeout: 5_000 }
    ).toBe(false)
  })
})

// ── Trailing output on exit ─────────────────────────────────────────────────

test.describe('Trailing PTY output on exit', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Ux Trailing', color: '#f97316', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({ projectId: p.id, title: 'Trailing output task', status: 'in_progress' })
    taskId = t.id

    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), taskId)
    await s.refreshData()
  })

  test('captures final output from a fast-exiting process', async ({ mainWindow }) => {
    const marker = `TRAILING_${Date.now()}`

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Trailing output task' })

    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)

    // Run a command that outputs a marker and exits immediately.
    // Without the delayed session cleanup, the final onData may be dropped.
    await runCommand(mainWindow, sessionId, `echo ${marker} && exit 0`)
    await waitForBufferContains(mainWindow, sessionId, marker)
    await waitForNoPtySession(mainWindow, sessionId)
  })
})
