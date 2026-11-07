/**
 * WebRTC direct link (docs/direct-link.md): with no listener the desktop can dial,
 * the hub brokers a WebRTC data channel to the computer, and the terminal's
 * keystrokes and output travel it — the same direct protocol as the WebSocket path.
 */
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/direct-rtc'
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
interface LinkStatus {
  hubId: string
  computers: Array<{ path: string; transport?: string }>
}

test.describe('Direct link over WebRTC: desktop terminal', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Direct RTC',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    const t = await s.createTask({
      projectId: p.id,
      title: 'Direct rtc task',
      status: 'in_progress'
    })
    taskId = t.id
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, agentId: 'terminal' }),
      taskId
    )
    await s.refreshData()
  })

  test('typing and output travel a WebRTC data channel to the local computer', async ({
    mainWindow
  }) => {
    await openTaskTerminal(mainWindow, { projectAbbrev: 'DI', taskTitle: 'Direct rtc task' })
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)

    const status = () =>
      mainWindow.evaluate(
        () =>
          (
            window as unknown as { __slayzone_directPty?: () => DirectStatus }
          ).__slayzone_directPty?.() ?? null
      )
    const links = () =>
      mainWindow.evaluate(
        () =>
          (
            window as unknown as { __slayzone_directLinks?: () => LinkStatus[] }
          ).__slayzone_directLinks?.() ?? []
      )
    await expect
      .poll(async () => (await status())?.sessionIds.includes(sessionId) ?? false, {
        timeout: 30_000
      })
      .toBe(true)
    expect((await links()).flatMap((h) => h.computers)).toContainEqual(
      expect.objectContaining({ path: 'direct', transport: 'webrtc' })
    )
    const before = (await status()) as DirectStatus

    const marker = `RTC_${Date.now()}`
    await mainWindow.locator('.xterm:visible textarea.xterm-helper-textarea').first().focus()
    await mainWindow.keyboard.type(`echo ${marker}`)
    await mainWindow.keyboard.press('Enter')
    await expect
      .poll(async () => ((await getViewportLines(mainWindow, sessionId)) ?? []).join('\n'), {
        timeout: 10_000
      })
      .toContain(marker)
    const after = (await status()) as DirectStatus
    expect(after.writes).toBeGreaterThan(before.writes)
    expect(after.chunks).toBeGreaterThan(before.chunks)
  })
})
