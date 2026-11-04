import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  openTaskTerminal,
  switchAgent,
  getMainSessionId,
  waitForPtySession,
  runCommand,
  readFullBuffer
} from '../fixtures/terminal'

const TARGET_SOFT = 65535

// Regression for: Bun-compiled CLIs (e.g. Factory.ai droid) fail with
// "An unknown error occurred (Unexpected)" when the PTY shell inherits the
// macOS default soft RLIMIT_NOFILE of 256. Two independent mechanisms should
// both land us above the target: (a) boot-time posix.setrlimit in Electron
// main, and (b) per-PTY /bin/sh wrapper that raises before exec'ing the shell.
test.describe('PTY fd limit — RLIMIT_NOFILE soft', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'FD Limit', color: '#f59e0b', path: TEST_PROJECT_PATH })
    const t = await s.createTask({ projectId: p.id, title: 'FD limit task', status: 'in_progress' })
    taskId = t.id
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev: 'FD', taskTitle: 'FD limit task' })
    await switchAgent(mainWindow, 'terminal')
  })

  test('PTY shell sees soft limit >= 65535 (or unlimited)', async ({ mainWindow }) => {
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)

    await runCommand(mainWindow, sessionId, 'echo "NOFILE:$(ulimit -n)"')

    // Match only the executed output — restrict to digits or the literal
    // "unlimited" so we don't pick up the echoed command line ($(ulimit -n)).
    await expect
      .poll(
        async () => {
          const buf = await readFullBuffer(mainWindow, sessionId)
          const match = buf.match(/NOFILE:(\d+|unlimited)\b/)
          if (!match) return 'pending'
          const raw = match[1]
          if (raw === 'unlimited') return 'ok'
          return parseInt(raw, 10) >= TARGET_SOFT ? 'ok' : `too-low:${raw}`
        },
        { timeout: 10_000, message: `expected PTY soft limit >= ${TARGET_SOFT}` }
      )
      .toBe('ok')
  })
})
