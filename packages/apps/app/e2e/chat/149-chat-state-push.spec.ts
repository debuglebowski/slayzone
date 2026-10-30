/**
 * Claude Code chat: the agent's state reaches the desktop as a push on
 * `pty.onStateChange` (chat session id `${taskId}:${tabId}`), like a terminal
 * agent's — so its status dot follows the turn live instead of on the next 15 s
 * `pty.sessionList` reconcile. Against the scripted fake CLI.
 */
import { resetApp } from '../fixtures/electron'
import { ev, expect, step, test } from '../fixtures/chat'

type W = Window & {
  getTrpcVanillaClient: () => {
    pty: {
      onStateChange: {
        subscribe: (
          input: undefined,
          opts: { onData: (e: { sessionId: string; newState: string; oldState: string }) => void }
        ) => { unsubscribe: () => void }
      }
    }
  }
  __slayzone_terminalStateStore: { getState: () => { byId: Record<string, string> } }
  __chatStatePushes?: string[]
}

test.describe('Chat state push', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test("a turn's running → idle reaches the renderer as pty.onStateChange pushes", async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat state push',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init(), ev.text('working on it')),
                step.sleep(1500),
                step.emit(ev.text('all done'), ev.result({ text: 'all done' }))
              ]
            ]
          }
        ]
      }
    })
    const sessionId = `${t.taskId}:${t.tabId}`
    // A second client's view of the hub: the renderer's own transport, subscribed
    // the way every client is.
    await t.page.evaluate((sid) => {
      const w = window as unknown as W
      w.__chatStatePushes = []
      w.getTrpcVanillaClient().pty.onStateChange.subscribe(undefined, {
        onData: (e) => {
          if (e.sessionId === sid) w.__chatStatePushes!.push(`${e.oldState}->${e.newState}`)
        }
      })
    }, sessionId)
    const pushes = (): Promise<string[]> =>
      t.page.evaluate(() => (window as unknown as W).__chatStatePushes ?? [])
    const dot = (): Promise<string | undefined> =>
      t.page.evaluate(
        (sid) => (window as unknown as W).__slayzone_terminalStateStore.getState().byId[sid],
        sessionId
      )

    await t.send('a job')
    // Pushed while the turn runs — the status dot's store has it, not a later poll.
    await expect.poll(pushes).toContain('idle->running')
    await expect.poll(dot).toBe('running')

    await expect(t.panel.getByText('all done')).toBeVisible()
    await expect.poll(pushes).toContain('running->idle')
    await expect.poll(dot).toBe('idle')
  })
})
