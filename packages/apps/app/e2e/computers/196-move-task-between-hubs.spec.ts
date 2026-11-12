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

/**
 * Moving a task to a project on ANOTHER hub, from the board's context menu: the menu
 * offers hub B's projects, the dialog says what the move carries, the progress card
 * runs it to the end, and the task — with its subtask, same ids — is on hub B and no
 * longer on the app's own hub.
 */
base.describe('move a task to another hub', () => {
  base('board menu → dialog → progress → the task lives on hub B', async () => {
    base.setTimeout(240_000)
    const store = fs.mkdtempSync(path.join(APP_DIR, 'e2e-move-hub-'))
    let hub: SecondHub | null = null
    let launched: Awaited<ReturnType<typeof launchIsolatedElectron>> | null = null
    try {
      hub = await spawnSecondHub(store)
      await waitForHubHealth(hub.port)
      const hubUrl = hub.url
      launched = await launchIsolatedElectron({
        name: 'move-task-between-hubs',
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

      // Hub B needs a computer for a project: the app's own joins it once signed in.
      const folderB = fs.mkdtempSync(path.join(os.homedir(), '.slz-e2e-move-b-'))
      let targetProjectId = ''
      await expect
        .poll(
          async () => {
            const created = (await withHubClient(hub!, (c) =>
              c.projects.create.mutate({ name: 'Target On B', color: '#16a34a', path: folderB })
            ).catch(() => null)) as { id: string } | null
            targetProjectId = created?.id ?? ''
            return targetProjectId !== ''
          },
          { timeout: 90_000, message: 'a project on hub B' }
        )
        .toBe(true)

      // A task with a subtask on the app's own hub.
      const folderA = fs.mkdtempSync(path.join(os.homedir(), '.slz-e2e-move-a-'))
      const ids = await page.evaluate(
        async ({ folder }) => {
          const c = window.getTrpcVanillaClient()
          const project = await c.projects.create.mutate({
            name: 'Source On A',
            color: '#2563eb',
            path: folder
          })
          const parent = await c.task.create.mutate({
            projectId: project.id,
            title: 'Cross hub mover',
            status: 'todo'
          })
          const child = await c.task.create.mutate({
            projectId: project.id,
            title: 'Cross hub child',
            status: 'todo',
            parentId: parent.id
          })
          return { project: project.id, parent: parent.id, child: child.id }
        },
        { folder: folderA }
      )
      await page.reload()
      await page.waitForSelector('#root', { timeout: 30_000 })

      await clickProject(page, 'SO')
      const card = page.getByText('Cross hub mover', { exact: true }).first()
      await expect(card).toBeVisible({ timeout: 20_000 })
      await card.click({ button: 'right' })
      const moveTo = page.getByRole('menuitem', { name: 'Move to' }).first()
      await moveTo.hover()
      await page
        .getByRole('menuitemradio', { name: /Target On B/ })
        .first()
        .click()

      const dialog = page.getByTestId('move-task-dialog')
      await expect(dialog.getByTestId('move-task-cross-hub-summary')).toBeVisible({
        timeout: 10_000
      })
      await expect(dialog.getByText('Bring subtasks (1)')).toBeVisible()
      const confirm = dialog.getByTestId('move-task-confirm')
      await expect(confirm).toBeEnabled({ timeout: 10_000 })
      await confirm.click()
      await expect(dialog).toBeHidden({ timeout: 10_000 })

      // On hub B with the same ids; gone from the app's own hub.
      await expect
        .poll(
          async () => {
            const onB = (await withHubClient(hub!, (c) => c.task.getAll.query())) as Array<{
              id: string
              project_id: string
              parent_id: string | null
            }>
            const parent = onB.find((t) => t.id === ids.parent)
            const child = onB.find((t) => t.id === ids.child)
            return [parent?.project_id, child?.parent_id]
          },
          { timeout: 60_000, message: 'the task and its subtask on hub B' }
        )
        .toEqual([targetProjectId, ids.parent])
      await expect
        .poll(
          () =>
            page.evaluate(async (id) => {
              const all = await window.getTrpcVanillaClient().task.getAll.query()
              return all.some((t: { id: string }) => t.id === id)
            }, ids.parent),
          { timeout: 30_000 }
        )
        .toBe(false)
      // The progress card goes away once the move is done.
      await expect(page.getByTestId('task-moves-panel')).toHaveCount(0, { timeout: 30_000 })
    } finally {
      if (launched) await launched.close()
      if (hub) await hub.stop()
    }
  })
})
