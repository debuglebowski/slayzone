/**
 * Direct client ↔ computer link (docs/direct-link.md): a desktop terminal on the
 * local computer reaches it directly — keystrokes go to the computer without the
 * hub, and output streams back from it — while the hub keeps the session's state.
 */
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  getViewportLines,
  openTaskTerminal,
  waitForPtySession
} from '../fixtures/terminal'

interface DirectStatus {
  sessionIds: string[]
  chunks: number
  writes: number
}

test.describe('Direct link: desktop terminal', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Direct Link',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    const t = await s.createTask({
      projectId: p.id,
      title: 'Direct link task',
      status: 'in_progress'
    })
    taskId = t.id
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, agentId: 'terminal' }),
      taskId
    )
    await s.refreshData()
  })

  test('typing and output travel the direct link to the local computer', async ({ mainWindow }) => {
    await openTaskTerminal(mainWindow, { projectAbbrev: 'DI', taskTitle: 'Direct link task' })
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)

    const status = () =>
      mainWindow.evaluate(
        () =>
          (
            window as unknown as { __slayzone_directPty?: () => DirectStatus }
          ).__slayzone_directPty?.() ?? null
      )
    await expect
      .poll(async () => (await status())?.sessionIds.includes(sessionId) ?? false, {
        timeout: 20_000
      })
      .toBe(true)
    const before = (await status()) as DirectStatus

    // Real keystrokes into xterm (not a hub `pty.write` from the test).
    const marker = `DIRECT_${Date.now()}`
    await mainWindow.locator('.xterm:visible textarea.xterm-helper-textarea').first().focus()
    await mainWindow.keyboard.type(`echo ${marker}`)
    await mainWindow.keyboard.press('Enter')

    await expect
      .poll(async () => ((await getViewportLines(mainWindow, sessionId)) ?? []).join('\n'), {
        timeout: 10_000
      })
      .toContain(`${marker}`)
    const after = (await status()) as DirectStatus
    expect(after.writes).toBeGreaterThan(before.writes)
    expect(after.chunks).toBeGreaterThan(before.chunks)
  })
})
