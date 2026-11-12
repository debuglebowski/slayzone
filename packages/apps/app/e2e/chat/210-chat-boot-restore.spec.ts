/**
 * Boot restore (task/server/agent-restore.ts): the hub restarts the chat agents
 * that were running at shutdown as soon as its computer connects. No tab has to
 * mount for it — restoring used to wait for each task's page to hydrate (98 s to
 * the first agent, 260 s to the 90th percentile, on 2026-11-11).
 *
 * The scenario: a chat that ran at shutdown, its tab closed, then the hub
 * restarts (the computer and the renderer stay up). The fake CLI must be started
 * by the hub alone.
 */
import { resetApp } from '../fixtures/electron'
import { closeAllTaskTabs } from '../fixtures/terminal'
import { echoTurn, expect, test } from '../fixtures/chat'

const setStartup = (page: import('@playwright/test').Page, mode: 'manual' | 'auto') =>
  page.evaluate(
    (value) =>
      window.getTrpcVanillaClient().settings.set.mutate({ key: 'terminal_agent_startup', value }),
    mode
  )

test.describe('Chat boot restore', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test.afterAll(async ({ mainWindow }) => {
    // The chat group runs under `manual` startup (no warm pool): leave it that way.
    await setStartup(mainWindow, 'manual')
  })

  test('the hub restarts a chat that ran at shutdown, with no tab open', async ({
    chat,
    electronApp,
    mainWindow: page
  }) => {
    const task = await chat.openTask({
      title: 'Ran at shutdown',
      scenario: { processes: [{ defaultTurn: echoTurn() }] },
      spawn: 'on-send'
    })
    await closeAllTaskTabs(page)
    // It was running when the app shut down; the startup mode restores those.
    await electronApp.evaluate(async ({}, taskId) => {
      const db = (globalThis as Record<string, unknown>).__db as {
        run: (sql: string, params?: unknown[]) => Promise<unknown>
      }
      await db.run("UPDATE terminal_tabs SET agent_state = 'running' WHERE id = ?", [taskId])
    }, task.taskId)
    await setStartup(page, 'auto')
    expect(task.epoch.runs()).toHaveLength(0)

    // Hub only: the computer (and so any agent) and this renderer stay up.
    const restarted = await page.evaluate(() =>
      (
        window as unknown as {
          api: { app: { restartSidecar: () => Promise<{ ok: boolean; error?: string }> } }
        }
      ).api.app.restartSidecar()
    )
    expect(restarted.ok).toBe(true)

    // Started by the hub: the fake ran, while no tab of the task was ever mounted.
    const run = await task.run(0, () => true, 30_000)
    expect(run).toBeTruthy()
    const openTabs = await page.evaluate(
      () =>
        (
          window as unknown as {
            __slayzone_tabStore: {
              getState: () => { tabs: Array<{ type: string; taskId?: string }> }
            }
          }
        ).__slayzone_tabStore
          .getState()
          .tabs.filter((t) => t.type === 'task').length
    )
    expect(openTabs).toBe(0)
  })
})
