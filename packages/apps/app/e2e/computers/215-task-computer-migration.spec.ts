import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { createFakeClaude, echoTurn } from '@slayzone/test-utils/fake-claude'
import { createFakeCodex } from '@slayzone/test-utils/fake-codex'
import {
  bootConfigPath,
  clickProject,
  launchIsolatedElectron,
  openTaskById
} from '../fixtures/electron'
import {
  APP_DIR,
  attachComputerToHub,
  authorizeHubInApp,
  spawnSecondHub,
  waitForHubHealth,
  withHubClient,
  type HubComputer,
  type SecondHub
} from '../fixtures/second-hub'
import { createComputerLink } from '../fixtures/computer-link'
import type { ComputerMove } from '@slayzone/task-contracts'

type App = Awaited<ReturnType<typeof launchIsolatedElectron>>
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

async function fixture(startAgent = false) {
  const store = fs.mkdtempSync(path.join(APP_DIR, 'e2e-task-computer-migration-'))
  const link = await createComputerLink()
  let hub: SecondHub | null = null
  let app: App | null = null
  const computers: HubComputer[] = []
  try {
    hub = await spawnSecondHub(store)
    await waitForHubHealth(hub.port)
    const fake = createFakeClaude({ root: path.join(store, 'fake-claude') })
    const codex = createFakeCodex({ root: path.join(store, 'fake-codex') })
    fs.copyFileSync(path.join(codex.binDir, 'codex'), path.join(fake.binDir, 'codex'))
    const epoch = fake.setScenario({
      processes: Array.from({ length: 4 }, () => ({ defaultTurn: echoTurn() }))
    })
    const env = (root: string) => ({
      SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR: fake.binDir,
      CLAUDE_CONFIG_DIR: path.join(root, '.claude'),
      CODEX_HOME: path.join(root, '.codex'),
      PATH: `${fake.binDir}${path.delimiter}${codex.binDir}${path.delimiter}${process.env.PATH ?? ''}`
    })
    const sourceRoot = path.join(store, 'source-files')
    const targetRoot = path.join(store, 'target-files')
    const source = await attachComputerToHub(hub, {
      storeDir: store,
      name: 'migration-source',
      allowedRoot: sourceRoot,
      extraEnv: env
    })
    computers.push(source)
    const target = await attachComputerToHub(hub, {
      storeDir: store,
      name: 'migration-target',
      allowedRoot: targetRoot,
      extraEnv: env,
      routeHub: link.route
    })
    computers.push(target)
    const sourceRepo = path.join(sourceRoot, 'project')
    const targetRepo = path.join(targetRoot, 'project')
    const worktree = path.join(sourceRoot, 'worktree')
    fs.mkdirSync(sourceRepo, { recursive: true })
    git(sourceRepo, 'init', '-q')
    git(sourceRepo, 'config', 'user.name', 'Migration Test')
    git(sourceRepo, 'config', 'user.email', 'migration@example.test')
    // A developer's global signing (1Password GPG) fails without a desktop prompt.
    git(sourceRepo, 'config', 'commit.gpgsign', 'false')
    git(sourceRepo, 'config', 'tag.gpgsign', 'false')
    fs.writeFileSync(path.join(sourceRepo, 'tracked.txt'), 'base\n')
    git(sourceRepo, 'add', '.')
    git(sourceRepo, 'commit', '-qm', 'base')
    git(targetRoot, 'clone', '-q', sourceRepo, targetRepo)
    git(sourceRepo, 'worktree', 'add', '-qb', 'feature', worktree)
    fs.writeFileSync(path.join(worktree, 'tracked.txt'), 'staged\n')
    git(worktree, 'add', 'tracked.txt')
    fs.writeFileSync(path.join(worktree, 'tracked.txt'), 'unstaged\n')
    fs.writeFileSync(path.join(worktree, '.gitignore'), 'ignored.bin\n')
    fs.writeFileSync(path.join(worktree, 'ignored.bin'), Buffer.alloc(512 * 1024, 0x5a))
    fs.writeFileSync(path.join(worktree, 'untracked.txt'), 'keep untracked')
    const ids = await withHubClient(hub, async (c) => {
      const project = (await c.projects.create.mutate({
        name: 'Migration E2E',
        iconLetters: 'MV',
        color: '#2563eb',
        computerId: source.computerId,
        path: sourceRepo
      })) as { id: string }
      await c.workspace.setProjectPath.mutate({
        projectId: project.id,
        computerId: target.computerId,
        path: targetRepo
      })
      const task = (await c.task.create.mutate({
        projectId: project.id,
        title: 'Move this working task',
        agentId: 'claude-chat',
        status: 'todo'
      })) as { id: string }
      await c.task.update.mutate({ id: task.id, worktreePath: worktree })
      const tab = (await c.taskTerminals.ensureMain.mutate({
        taskId: task.id,
        mode: 'claude-chat'
      })) as { id: string }
      await c.chat.testSeedEvents.mutate({
        tabId: tab.id,
        fromSeq: 0,
        events: [
          { kind: 'user-message', id: 'before-move', text: 'History from the source computer' }
        ]
      })
      return { projectId: project.id, taskId: task.id, tabId: tab.id }
    })
    const launch = (userDataDir?: string) =>
      launchIsolatedElectron({
        name: 'task-computer-migration',
        userDataDir,
        seedUserData: (dir) => {
          fs.mkdirSync(path.dirname(bootConfigPath(dir)), { recursive: true })
          fs.writeFileSync(
            bootConfigPath(dir),
            JSON.stringify({
              server_mode: 'local',
              multi_hub: true,
              hubs: [
                { id: 'migration-hub', kind: 'remote', label: 'Migration Hub', url: hub!.url }
              ],
              default_hub_id: 'local'
            })
          )
        },
        extraEnv: () => ({
          SLAYZONE_E2E_NO_COMPUTER: '1',
          SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR: fake.binDir
        })
      })
    app = await launch()
    await app.page.waitForSelector('#root')
    await authorizeHubInApp(app.page, 'migration-hub', hub.token)
    const open = async (page: Page) => {
      await clickProject(page, 'MV')
      try {
        await openTaskById(page, ids.taskId)
      } catch (error) {
        await test.info().attach('migration-task-screen', {
          body: await page.locator('body').innerText(),
          contentType: 'text/plain'
        })
        throw error
      }
      await expect(page.getByTestId('task-settings-panel').filter({ visible: true })).toBeVisible()
    }
    await open(app.page)
    if (startAgent) {
      await withHubClient(hub, (c) =>
        c.chat.start.mutate({
          taskId: ids.taskId,
          tabId: ids.tabId,
          mode: 'claude-chat',
          cwd: worktree
        })
      )
      await epoch.waitForRun(0)
      const panel = app.page.locator(`[data-chat-panel][data-chat-tab-id="${ids.tabId}"]:visible`)
      await panel.locator('textarea').fill('source prompt')
      await panel.locator('textarea').press('Enter')
      await expect(panel.getByText('echo: source prompt', { exact: true })).toBeVisible({
        timeout: 20_000
      })
    }
    const read = () =>
      withHubClient(
        hub!,
        async (c) =>
          (await c.task.computerMove.query({ taskId: ids.taskId })) as ComputerMove | null
      )
    return {
      store,
      hub,
      source,
      target,
      worktree,
      targetRepo,
      ids,
      link,
      read,
      epoch,
      startAgent,
      get page() {
        return app!.page
      },
      async restartApp() {
        const data = app!.userDataDir
        await app!.close()
        app = await launch(data)
        await app.page.waitForSelector('#root')
        await open(app.page)
      },
      async close() {
        await app?.close()
        for (const computer of computers) await computer.stop()
        await link.close()
        await hub?.stop()
        fs.rmSync(store, { recursive: true, force: true })
      }
    }
  } catch (error) {
    await app?.close()
    for (const computer of computers) await computer.stop()
    await link.close()
    await hub?.stop()
    fs.rmSync(store, { recursive: true, force: true })
    throw error
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
async function openChangeComputer(f: Fixture) {
  await f.page.getByRole('button', { name: 'Change computer…', exact: true }).click()
  const dialog = f.page.getByRole('dialog', { name: 'Change computer', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}
async function chooseDestination(f: Fixture) {
  const dialog = await openChangeComputer(f)
  await dialog.getByRole('combobox', { name: 'Computer', exact: true }).click()
  await f.page.getByRole('option', { name: 'migration-target', exact: true }).click()
  return dialog
}
async function begin(f: Fixture) {
  const dialog = await chooseDestination(f)
  await dialog.getByRole('button', { name: 'Move to migration-target', exact: true }).click()
  await expect(dialog).toBeHidden()
}
async function sourceIntact(f: Fixture) {
  const task = (await withHubClient(f.hub, (c) => c.task.get.query({ id: f.ids.taskId }))) as {
    project_id: string
  }
  expect(task.project_id).toBe(f.ids.projectId)
  expect(fs.readFileSync(path.join(f.worktree, 'tracked.txt'), 'utf8')).toBe('unstaged\n')
  expect(git(f.worktree, 'show', ':tracked.txt')).toBe('staged')
}
async function completed(f: Fixture) {
  await expect.poll(async () => (await f.read())?.status, { timeout: 60_000 }).toBe('done')
  await expect(f.page.getByText('Runs on migration-target', { exact: true })).toBeVisible({
    timeout: 15_000
  })
  await sourceIntact(f)
  const paths = (await withHubClient(f.hub, (c) =>
    c.task.paths.query({ taskIds: [f.ids.taskId] })
  )) as Record<string, { state: string; worktreePath: string }>
  const destination = paths[f.ids.taskId]
  expect(destination.state).toBe('ok')
  expect(destination.worktreePath.startsWith(f.targetRepo + path.sep)).toBe(true)
  expect(fs.readFileSync(path.join(destination.worktreePath, 'tracked.txt'), 'utf8')).toBe(
    'unstaged\n'
  )
  expect(git(destination.worktreePath, 'show', ':tracked.txt')).toBe('staged')
  expect(fs.readFileSync(path.join(destination.worktreePath, 'ignored.bin'))).toEqual(
    Buffer.alloc(512 * 1024, 0x5a)
  )
  expect(fs.readFileSync(path.join(destination.worktreePath, 'untracked.txt'), 'utf8')).toBe(
    'keep untracked'
  )
  await f.source.stop()
  const events = (await withHubClient(f.hub, (c) =>
    c.chat.testReadEvents.query({ tabId: f.ids.tabId, afterSeq: -1, limit: 100 })
  )) as Array<{ event: { text?: string } }>
  expect(events.map((row) => row.event.text)).toContain('History from the source computer')
  return destination.worktreePath
}

test.describe('Computer field: full task migration', () => {
  test.setTimeout(240_000)
  test('moves real files and history through the UI while preserving the project and source', async () => {
    const f = await fixture(true)
    try {
      await begin(f)
      await expect.poll(() => f.epoch.run(0)?.exit(), { timeout: 15_000 }).toBeDefined()
      const destination = await completed(f)
      const panel = f.page.locator(`[data-chat-panel][data-chat-tab-id="${f.ids.tabId}"]:visible`)
      await expect(panel.getByText('echo: source prompt', { exact: true })).toBeVisible()
      await panel.locator('textarea').fill('destination prompt')
      await panel.locator('textarea').press('Enter')
      await expect
        .poll(() => f.epoch.runs().filter((run) => run.cwd === destination).length, {
          timeout: 20_000
        })
        .toBe(1)
      const resumed = f.epoch.runs().find((run) => run.cwd === destination)!
      expect(resumed.resumed).toBe(true)
      expect(resumed.sessionId).toBe(f.epoch.run(0)?.sessionId)
      await expect(panel.getByText('echo: destination prompt', { exact: true })).toBeVisible({
        timeout: 20_000
      })
    } finally {
      await f.close()
    }
  })
  test('disconnect mid-transfer keeps source authoritative; Retry completes the move', async () => {
    const f = await fixture()
    try {
      const held = f.link.holdNextWrite()
      await begin(f)
      await held
      f.link.disconnect()
      await expect.poll(async () => (await f.read())?.status, { timeout: 30_000 }).toBe('failed')
      await sourceIntact(f)
      const resolved = (await withHubClient(f.hub, (c) =>
        c.computers.resolveTaskComputer.query({ taskId: f.ids.taskId })
      )) as { computerId: string }
      expect(resolved.computerId).toBe(f.source.computerId)
      f.link.reconnect()
      await expect
        .poll(
          () =>
            withHubClient(
              f.hub,
              async (c) =>
                ((await c.computers.list.query()) as Array<{ id: string; usable: boolean }>).find(
                  (row) => row.id === f.target.computerId
                )?.usable
            ),
          { timeout: 60_000 }
        )
        .toBe(true)
      await f.page.getByRole('button', { name: 'Retry move', exact: true }).click()
      await completed(f)
    } finally {
      await f.close()
    }
  })
  test('Cancel after a disconnect releases the source task without switching ownership', async () => {
    const f = await fixture()
    try {
      const held = f.link.holdNextWrite()
      await begin(f)
      await held
      f.link.disconnect()
      await expect.poll(async () => (await f.read())?.status, { timeout: 30_000 }).toBe('failed')
      await f.page.getByRole('button', { name: 'Cancel move', exact: true }).click()
      await expect.poll(async () => (await f.read())?.status).toBe('canceled')
      await expect(
        f.page.getByRole('button', { name: 'Change computer…', exact: true })
      ).toBeEnabled()
      await sourceIntact(f)
      await withHubClient(f.hub, (c) =>
        c.task.update.mutate({ id: f.ids.taskId, title: 'Source task remains editable' })
      )
      const resolved = (await withHubClient(f.hub, (c) =>
        c.computers.resolveTaskComputer.query({ taskId: f.ids.taskId })
      )) as { computerId: string }
      expect(resolved.computerId).toBe(f.source.computerId)
    } finally {
      await f.close()
    }
  })
  test('reopening the app during a held transfer restores progress and completes safely', async () => {
    const f = await fixture()
    try {
      const held = f.link.holdNextWrite()
      await begin(f)
      await held
      await f.restartApp()
      await expect(f.page.getByText('Copying files', { exact: false })).toBeVisible({
        timeout: 15_000
      })
      await expect(
        f.page.getByRole('button', { name: 'Change computer…', exact: true })
      ).toBeDisabled()
      f.link.release()
      await completed(f)
    } finally {
      await f.close()
    }
  })
  test('offline destination blocks migration; unsupported sessions require consent', async () => {
    const f = await fixture()
    try {
      f.link.disconnect()
      await expect
        .poll(
          () =>
            withHubClient(
              f.hub,
              async (c) =>
                ((await c.computers.list.query()) as Array<{ id: string; usable: boolean }>).find(
                  (row) => row.id === f.target.computerId
                )?.usable
            ),
          { timeout: 30_000 }
        )
        .toBe(false)
      const dialog = await openChangeComputer(f)
      await dialog.getByRole('combobox', { name: 'Computer', exact: true }).click()
      await f.page.getByRole('option', { name: /migration-target/ }).click()
      await expect(dialog.getByText(/must be online/)).toBeVisible()
      await expect(
        dialog.getByRole('button', { name: 'Move to migration-target', exact: true })
      ).toBeDisabled()
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(await f.read()).toBeNull()
      f.link.reconnect()
      await expect
        .poll(
          () =>
            withHubClient(
              f.hub,
              async (c) =>
                ((await c.computers.list.query()) as Array<{ id: string; usable: boolean }>).find(
                  (row) => row.id === f.target.computerId
                )?.usable
            ),
          { timeout: 60_000 }
        )
        .toBe(true)
      // A real terminal-style Codex session has no portable automatic resume.
      await withHubClient(f.hub, async (c) => {
        const tab = (await c.taskTerminals.create.mutate({
          taskId: f.ids.taskId,
          mode: 'codex',
          label: 'Codex terminal'
        })) as { id: string }
        await c.task.testRecordPendingSpawn.mutate({
          taskId: f.ids.taskId,
          tabId: tab.id,
          mode: 'codex',
          expectedSessionId: 'unsupported-session'
        })
      })
      const consent = await chooseDestination(f)
      await expect(
        consent.getByRole('button', { name: 'Move to migration-target', exact: true })
      ).toBeDisabled()
      await consent.getByRole('checkbox').check()
      await expect(
        consent.getByRole('button', { name: 'Move to migration-target', exact: true })
      ).toBeEnabled()
      await consent.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(await f.read()).toBeNull()
      await sourceIntact(f)
    } finally {
      await f.close()
    }
  })
})
