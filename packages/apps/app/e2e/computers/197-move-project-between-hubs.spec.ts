import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test as base, expect } from '@playwright/test'
import {
  bootConfigPath,
  clickProject,
  launchIsolatedElectron,
  waitForUsableComputer
} from '../fixtures/electron'
import {
  APP_DIR,
  authorizeHubInApp,
  spawnSecondHub,
  waitForHubHealth,
  withHubClient,
  type SecondHub
} from '../fixtures/second-hub'
import { readChatEvents, seedChatEvents } from '../fixtures/chat-seed'

type Launched = Awaited<ReturnType<typeof launchIsolatedElectron>>

/**
 * Moving a whole project to ANOTHER hub, from the project rail: "Move to hub…" on the
 * project's menu, the dialog says what moves, the progress card runs it, and the
 * project — same id, with its task and subtask — lives on hub B and no longer on the
 * app's own hub. A task's chat goes with it ("Keep agent sessions", on by default): hub B
 * reads the conversation the app's own hub held. The rail still shows it (from hub B).
 */
base.describe('move a project to another hub', () => {
  base('rail menu → dialog → progress → the project lives on hub B', async () => {
    base.setTimeout(240_000)
    const store = fs.mkdtempSync(path.join(APP_DIR, 'e2e-move-project-hub-'))
    let hub: SecondHub | null = null
    let launched: Launched | null = null
    try {
      hub = await spawnSecondHub(store)
      await waitForHubHealth(hub.port)
      const hubUrl = hub.url
      launched = await launchIsolatedElectron({
        name: 'move-project-between-hubs',
        seedUserData: (userDataDir) => {
          fs.mkdirSync(path.dirname(bootConfigPath(userDataDir)), { recursive: true })
          fs.writeFileSync(
            bootConfigPath(userDataDir),
            JSON.stringify({
              server_mode: 'local',
              multi_hub: true,
              hubs: [{ id: 'remote-b', kind: 'remote', label: 'Hub B', url: hubUrl }],
              default_hub_id: 'local'
            })
          )
        },
        extraEnv: (userDataDir) => ({ SLAYZONE_ROOT: userDataDir })
      })
      const page = launched.page
      await page.waitForSelector('#root', { timeout: 20_000 })
      expect(await waitForUsableComputer(page), 'local computer up').toBe(true)
      await authorizeHubInApp(page, 'remote-b', hub.token)
      // Hub B gets a computer once the app's own joins it (a project there needs one).
      const folderB = fs.mkdtempSync(path.join(os.homedir(), '.slz-e2e-move-project-b-'))
      await expect
        .poll(
          async () =>
            ((await withHubClient(hub!, (c) =>
              c.projects.create.mutate({ name: 'Already On B', color: '#16a34a', path: folderB })
            ).catch(() => null)) as { id: string } | null) !== null,
          { timeout: 90_000, message: 'hub B has a computer' }
        )
        .toBe(true)

      // A project on the app's own hub, with a task and a subtask.
      const folderA = fs.mkdtempSync(path.join(os.homedir(), '.slz-e2e-move-project-a-'))
      const ids = await page.evaluate(async (folder) => {
        const c = window.getTrpcVanillaClient()
        const project = await c.projects.create.mutate({
          name: 'Wandering Project',
          color: '#2563eb',
          path: folder
        })
        const parent = await c.task.create.mutate({
          projectId: project.id,
          title: 'Wandering task',
          status: 'todo'
        })
        const child = await c.task.create.mutate({
          projectId: project.id,
          title: 'Wandering child',
          status: 'todo',
          parentId: parent.id
        })
        const chatTask = await c.task.create.mutate({
          projectId: project.id,
          title: 'Wandering chat',
          status: 'todo',
          agentId: 'claude-chat'
        })
        const tab = await c.taskTerminals.ensureMain.mutate({
          taskId: chatTask.id,
          mode: 'claude-chat'
        })
        return {
          project: project.id,
          parent: parent.id,
          child: child.id,
          chatTask: chatTask.id,
          tab: tab.id
        }
      }, folderA)
      // A conversation on the app's own computer, as an earlier session left it.
      await seedChatEvents(page, ids.tab, [
        { kind: 'user-message', id: 'u1', text: 'asked before the project moved' }
      ])
      expect((await readChatEvents(page, ids.tab)).map((e) => e.event.kind)).toEqual([
        'user-message'
      ])
      await page.reload()
      await page.waitForSelector('#root', { timeout: 30_000 })
      await clickProject(page, 'WA')

      // The project's menu in the rail → Move to hub… → the dialog.
      const tile = page.locator('[data-slot="sidebar"]').first().getByRole('button', {
        name: 'WA',
        exact: true
      })
      const moveItem = page.getByTestId('project-move-to-hub')
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await tile.last().click({ button: 'right' })
        if (
          await moveItem.waitFor({ timeout: 4_000 }).then(
            () => true,
            () => false
          )
        )
          break
        await page.keyboard.press('Escape')
      }
      await moveItem.click()
      const dialog = page.getByTestId('move-project-dialog')
      await expect(dialog.getByTestId('move-project-summary')).toBeVisible({ timeout: 10_000 })
      await expect(dialog.getByText(/3 tasks/)).toBeVisible()
      await expect(dialog.getByTestId('move-project-include-sessions')).toBeChecked()
      const confirm = dialog.getByTestId('move-project-confirm')
      await expect(confirm).toBeEnabled({ timeout: 10_000 })
      await confirm.click()
      await expect(dialog).toBeHidden({ timeout: 10_000 })

      // On hub B: the project and both tasks, same ids.
      await expect
        .poll(
          async () => {
            const projects = (await withHubClient(hub!, (c) => c.projects.list.query())) as Array<{
              id: string
              name: string
            }>
            const tasks = (await withHubClient(hub!, (c) => c.task.getAll.query())) as Array<{
              id: string
              project_id: string
              parent_id: string | null
            }>
            return [
              projects.find((p) => p.id === ids.project)?.name,
              tasks.find((t) => t.id === ids.parent)?.project_id,
              tasks.find((t) => t.id === ids.child)?.parent_id
            ]
          },
          { timeout: 60_000, message: 'the project and its tasks on hub B' }
        )
        .toEqual(['Wandering Project', ids.project, ids.parent])
      // Gone from the app's own hub; the progress card is gone once the move is done.
      await expect
        .poll(
          () =>
            page.evaluate(
              async (projectId) =>
                (await window.getTrpcVanillaClient().projects.list.query()).some(
                  (p: { id: string }) => p.id === projectId
                ),
              ids.project
            ),
          { timeout: 30_000 }
        )
        .toBe(false)
      await expect(page.getByTestId('task-moves-panel')).toHaveCount(0, { timeout: 30_000 })
      // The chat went along: hub B reads it from its computer, with what it held.
      await expect
        .poll(
          async () =>
            (
              (await withHubClient(hub!, (c) =>
                c.chat.testReadEvents.query({ tabId: ids.tab, afterSeq: -1, limit: 100 })
              ).catch((e: Error) => [e.message])) as Array<string | { event: { kind: string } }>
            ).map((e) => (typeof e === 'string' ? e : e.event.kind)),
          { timeout: 60_000, message: 'the chat on hub B' }
        )
        .toEqual(['user-message'])
      // The rail still offers it — from hub B now.
      await clickProject(page, 'WA')
    } finally {
      if (launched) await launched.close()
      if (hub) await hub.stop()
      fs.rmSync(store, { recursive: true, force: true })
    }
  })
})
