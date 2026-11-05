/**
 * Direct link fallback (docs/direct-link.md): when the direct connect fails (here the
 * renderer cannot create a WebRTC peer, and the computer has no dialable listener),
 * the terminal stays on the hub relay — typing and output work, nothing is direct,
 * and Diagnostics says why.
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
  writes: number
}
interface LinkStatus {
  computers: Array<{ path: string; reason?: string }>
}

test.describe('Direct link fallback: desktop terminal', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    // The reload drops any peer an earlier spec in this worker opened.
    await resetApp(mainWindow)
    // Every WebRTC attempt fails at once.
    await mainWindow.evaluate(() => {
      ;(window as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = class {
        constructor() {
          throw new Error('WebRTC unavailable (test)')
        }
      }
    })
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Direct Fallback',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    const t = await s.createTask({ projectId: p.id, title: 'Fallback task', status: 'in_progress' })
    taskId = t.id
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, agentId: 'terminal' }),
      taskId
    )
    await s.refreshData()
  })

  test('a failed direct connect leaves the terminal on the hub relay, working', async ({
    mainWindow
  }) => {
    await openTaskTerminal(mainWindow, { projectAbbrev: 'DI', taskTitle: 'Fallback task' })
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)
    const links = () =>
      mainWindow.evaluate(
        () =>
          (
            window as unknown as { __slayzone_directLinks?: () => LinkStatus[] }
          ).__slayzone_directLinks?.() ?? []
      )
    await expect
      .poll(async () => (await links()).flatMap((h) => h.computers), { timeout: 30_000 })
      .toContainEqual(expect.objectContaining({ path: 'relay', reason: 'rtc' }))

    const marker = `RELAY_${Date.now()}`
    await mainWindow.locator('.xterm:visible textarea.xterm-helper-textarea').first().focus()
    await mainWindow.keyboard.type(`echo ${marker}`)
    await mainWindow.keyboard.press('Enter')
    await expect
      .poll(async () => ((await getViewportLines(mainWindow, sessionId)) ?? []).join('\n'), {
        timeout: 10_000
      })
      .toContain(marker)
    const status = (await mainWindow.evaluate(
      () =>
        (
          window as unknown as { __slayzone_directPty?: () => DirectStatus }
        ).__slayzone_directPty?.() ?? null
    )) as DirectStatus
    expect(status.sessionIds).not.toContain(sessionId)
    expect(status.writes).toBe(0)
  })
})
