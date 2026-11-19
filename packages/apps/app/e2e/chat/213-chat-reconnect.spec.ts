/**
 * Reconnect recovery: while the chat's stream is down the panel says it is
 * reconnecting (the turn state it holds is only the last known one), and once
 * back it catches up with the server's state by itself — no page reload, no
 * stale "working" or "idle". The hub (sidecar) is SIGKILLed mid-turn, the tab on
 * the hub stream (remote computers, mobile, before a direct link is up).
 */
import { resetApp } from '../fixtures/electron'
import { echoTurn, ev, expect, step, test } from '../fixtures/chat'

test.describe('Chat reconnect recovery', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a hub restart mid-turn: "Reconnecting…" while down, then the server state, no reload', async ({
    chat,
    electronApp,
    mainWindow
  }) => {
    test.setTimeout(180_000)
    // The hub stream, not the direct link to the computer (which the hub's death
    // does not cut; its own loss reloads the tab): refuse the direct socket.
    await mainWindow.routeWebSocket(/\/direct\/v1/, (ws) => ws.close())
    const t = await chat.openTask({
      title: 'Reconnect mid-turn',
      scenario: {
        processes: [
          {
            turns: [[step.emit(ev.init(), ev.text('working on it')), step.hang()]],
            defaultTurn: echoTurn()
          },
          // A computer that restarts with the hub spawns the agent again.
          { defaultTurn: echoTurn() }
        ]
      }
    })
    await t.send('a long job')
    await expect(t.panel.getByText('working on it')).toBeVisible()
    await expect(t.stopButton).toBeVisible()
    expect(
      await t.page.evaluate(
        () =>
          (
            window as unknown as { __slayzone_directChat?: () => { tabIds: string[] } }
          ).__slayzone_directChat?.().tabIds
      )
    ).toEqual([])
    // Marks this document: a page reload would drop it.
    await t.page.evaluate(() => {
      ;(window as unknown as { __reconnectMark?: number }).__reconnectMark = 1
    })

    type Status = { health: string; pid: number | null }
    const status = async (): Promise<Status> =>
      (await mainWindow.evaluate(() => window.__testInvoke('app:get-sidecar-status'))) as Status
    await expect.poll(async () => (await status()).health, { timeout: 30_000 }).toBe('ready')
    const before = await status()
    await electronApp.evaluate((_electron, pid) => {
      process.kill(pid, 'SIGKILL')
    }, before.pid!)

    // Down: the last known "working" is not presented as the server's.
    await expect(t.panel.getByTestId('chat-reconnecting')).toBeVisible({ timeout: 15_000 })
    await expect(t.panel.getByText('Reconnecting…')).toBeVisible()

    await expect
      .poll(
        async () => {
          const s = await status()
          return s.health === 'ready' && s.pid !== before.pid
        },
        { timeout: 60_000 }
      )
      .toBe(true)

    // Back and caught up: the indicator goes, the panel shows the server's state.
    await expect(t.panel.getByTestId('chat-reconnecting')).toHaveCount(0, { timeout: 60_000 })
    // The turn either survived (its computer kept running) or ended with the
    // process: Stop then ends it; either way the panel settles idle and usable.
    if (await t.stopButton.isVisible()) await t.stopButton.click()
    await expect(t.sendButton).toBeVisible({ timeout: 30_000 })
    await t.send('after reconnect')
    await expect(t.panel.getByText('echo: after reconnect')).toBeVisible({ timeout: 60_000 })
    // All of it without a page reload.
    expect(
      await t.page.evaluate(
        () => (window as unknown as { __reconnectMark?: number }).__reconnectMark
      )
    ).toBe(1)
  })
})
