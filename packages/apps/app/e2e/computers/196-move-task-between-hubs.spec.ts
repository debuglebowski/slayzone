import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
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

/** The app (multi-hub, its own hub `local`) beside hub B, with a project on hub B. */
async function setUp(name: string, store: string) {
  const hub = await spawnSecondHub(store)
  let launched: Launched | null = null
  try {
    await waitForHubHealth(hub.port)
    const hubUrl = hub.url
    launched = await launchIsolatedElectron({
      name,
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
          const created = (await withHubClient(hub, (c) =>
            c.projects.create.mutate({ name: 'Target On B', color: '#16a34a', path: folderB })
          ).catch(() => null)) as { id: string } | null
          targetProjectId = created?.id ?? ''
          return targetProjectId !== ''
        },
        { timeout: 90_000, message: 'a project on hub B' }
      )
      .toBe(true)
    return { hub, launched, page, targetProjectId }
  } catch (error) {
    if (launched) await launched.close()
    await hub.stop()
    throw error
  }
}

/** A project on the app's own hub. */
async function projectOnA(page: Page, name: string) {
  const folder = fs.mkdtempSync(path.join(os.homedir(), '.slz-e2e-move-a-'))
  return page.evaluate(
    async ({ name, folder }) =>
      (
        await window
          .getTrpcVanillaClient()
          .projects.create.mutate({ name, color: '#2563eb', path: folder })
      ).id,
    { name, folder }
  )
}

/** Board of `projectAbbrev` → the card's menu → Move to → `target`: the open dialog. */
async function openMoveDialog(page: Page, projectAbbrev: string, title: string, target: RegExp) {
  await clickProject(page, projectAbbrev)
  const card = page.getByText(title, { exact: true }).first()
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to' }).first().hover()
  await page.getByRole('menuitemradio', { name: target }).first().click()
  const dialog = page.getByTestId('move-task-dialog')
  await expect(dialog.getByTestId('move-task-cross-hub-summary')).toBeVisible({
    timeout: 10_000
  })
  return dialog
}

async function confirmMove(page: Page) {
  const dialog = page.getByTestId('move-task-dialog')
  const confirm = dialog.getByTestId('move-task-confirm')
  await expect(confirm).toBeEnabled({ timeout: 10_000 })
  await confirm.click()
  await expect(dialog).toBeHidden({ timeout: 10_000 })
}

async function tasksOnB(hub: SecondHub) {
  return (await withHubClient(hub, (c) => c.task.getAll.query())) as Array<{
    id: string
    project_id: string
    parent_id: string | null
  }>
}

async function projectOnAppHub(page: Page, id: string): Promise<string | null> {
  return page.evaluate(async (taskId) => {
    const all = await window.getTrpcVanillaClient().task.getAll.query()
    return all.find((t: { id: string }) => t.id === taskId)?.project_id ?? null
  }, id)
}

/** The app's own hub database (E2E-gated `__db` forwarder). */
function hubDbAll<T>(app: ElectronApplication, sql: string, params: unknown[] = []) {
  return app.evaluate(
    async ({}, { q, p }) => {
      const d = (globalThis as Record<string, unknown>).__db as {
        all: (sql: string, params?: unknown[]) => Promise<unknown[]>
      }
      return d.all(q, p)
    },
    { q: sql, p: params }
  ) as Promise<T[]>
}

/** Run `fn` with the app beside hub B; the app, the hub and its store are torn down after. */
async function inTwoHubs(
  name: string,
  fn: (env: Awaited<ReturnType<typeof setUp>>) => Promise<void>
) {
  const store = fs.mkdtempSync(path.join(APP_DIR, `e2e-move-hub-${name}-`))
  let env: Awaited<ReturnType<typeof setUp>> | null = null
  try {
    env = await setUp(`move-task-${name}`, store)
    await fn(env)
  } finally {
    if (env) {
      await env.launched.close()
      await env.hub.stop()
    }
    fs.rmSync(store, { recursive: true, force: true })
  }
}

/** Start a move on the app's hub the way the dialog does, but leave nobody driving it. */
function beginMove(page: Page, taskIds: string[], targetProjectId: string) {
  return page.evaluate(
    async ({ taskIds, targetProjectId }) =>
      (
        await window.getTrpcVanillaClient().taskMoves.begin.mutate({
          id: crypto.randomUUID(),
          taskIds,
          targetHubId: 'remote-b',
          targetProjectId,
          includeSubtasks: true
        })
      ).id,
    { taskIds, targetProjectId }
  )
}

function pauseMove(page: Page, id: string) {
  return page.evaluate(
    (moveId) => window.getTrpcVanillaClient().taskMoves.pause.mutate({ id: moveId }),
    id
  )
}

/** Run a statement on the app's own hub database (E2E-gated `__db` forwarder). */
function hubDbRun(app: ElectronApplication, sql: string, params: unknown[] = []) {
  return app.evaluate(
    async ({}, { q, p }) => {
      const d = (globalThis as Record<string, unknown>).__db as {
        run: (sql: string, params?: unknown[]) => Promise<unknown>
      }
      await d.run(q, p)
    },
    { q: sql, p: params }
  )
}

async function createTaskOnA(page: Page, projectId: string, title: string, extra = {}) {
  return page.evaluate(
    async ({ projectId, title, extra }) =>
      (
        await window
          .getTrpcVanillaClient()
          .task.create.mutate({ projectId, title, status: 'todo', ...extra })
      ).id,
    { projectId, title, extra }
  )
}

/** The message a title edit on the app's own hub is answered with ('written' = accepted). */
function editTitle(page: Page, id: string, title: string) {
  return page.evaluate(
    ({ id, title }) =>
      window
        .getTrpcVanillaClient()
        .task.update.mutate({ id, title })
        .then(
          () => 'written',
          (e: Error) => e.message
        ),
    { id, title }
  )
}

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
    let launched: Launched | null = null
    try {
      const up = await setUp('move-task-between-hubs', store)
      hub = up.hub
      launched = up.launched
      const { page, targetProjectId } = up

      // A task with a subtask on the app's own hub.
      const sourceProjectId = await projectOnA(page, 'Source On A')
      const ids = await page.evaluate(async (projectId) => {
        const c = window.getTrpcVanillaClient()
        const parent = await c.task.create.mutate({
          projectId,
          title: 'Cross hub mover',
          status: 'todo'
        })
        const child = await c.task.create.mutate({
          projectId,
          title: 'Cross hub child',
          status: 'todo',
          parentId: parent.id
        })
        return { parent: parent.id, child: child.id }
      }, sourceProjectId)
      await page.reload()
      await page.waitForSelector('#root', { timeout: 30_000 })

      const dialog = await openMoveDialog(page, 'SO', 'Cross hub mover', /Target On B/)
      await expect(dialog.getByText('Bring subtasks (1)')).toBeVisible()
      await confirmMove(page)

      // On hub B with the same ids; gone from the app's own hub.
      await expect
        .poll(
          async () => {
            const onB = await tasksOnB(hub!)
            const parent = onB.find((t) => t.id === ids.parent)
            const child = onB.find((t) => t.id === ids.child)
            return [parent?.project_id, child?.parent_id]
          },
          { timeout: 60_000, message: 'the task and its subtask on hub B' }
        )
        .toEqual([targetProjectId, ids.parent])
      await expect.poll(() => projectOnAppHub(page, ids.parent), { timeout: 30_000 }).toBe(null)
      // The progress card goes away once the move is done.
      await expect(page.getByTestId('task-moves-panel')).toHaveCount(0, { timeout: 30_000 })
    } finally {
      if (launched) await launched.close()
      if (hub) await hub.stop()
      fs.rmSync(store, { recursive: true, force: true })
    }
  })

  /**
   * A task leaving a hub is removed there, not deleted: its computer keeps the task's
   * chat (never told to erase it nor to refuse the task id), so when the task moves
   * back the chat opens again with its history.
   */
  base('a task with a chat moves to hub B and back: its chat is still there', async () => {
    base.setTimeout(300_000)
    const store = fs.mkdtempSync(path.join(APP_DIR, 'e2e-move-hub-back-'))
    let hub: SecondHub | null = null
    let launched: Launched | null = null
    try {
      const up = await setUp('move-task-between-hubs-back', store)
      hub = up.hub
      launched = up.launched
      const { page, targetProjectId } = up
      const app = launched.app

      const sourceProjectId = await projectOnA(page, 'Source On A')
      const { taskId, tabId } = await page.evaluate(async (projectId) => {
        const c = window.getTrpcVanillaClient()
        const task = await c.task.create.mutate({
          projectId,
          title: 'Chat mover',
          status: 'todo',
          agentId: 'claude-chat'
        })
        const tab = await c.taskTerminals.ensureMain.mutate({
          taskId: task.id,
          mode: 'claude-chat'
        })
        return { taskId: task.id, tabId: tab.id }
      }, sourceProjectId)
      // A conversation on the app's own computer, as an earlier session left it.
      await seedChatEvents(page, tabId, [
        { kind: 'user-message', id: 'u1', text: 'asked before the move' }
      ])
      const before = await readChatEvents(page, tabId)
      expect(before.map((e) => e.event.kind)).toEqual(['user-message'])
      const [{ id: conversationId }] = await hubDbAll<{ id: string }>(
        app,
        'SELECT id FROM chat_ownership WHERE tab_id = ?',
        [tabId]
      )
      await page.reload()
      await page.waitForSelector('#root', { timeout: 30_000 })

      // Away to hub B.
      await openMoveDialog(page, 'SO', 'Chat mover', /Target On B/)
      await confirmMove(page)
      await expect
        .poll(async () => (await tasksOnB(hub!)).find((t) => t.id === taskId)?.project_id, {
          timeout: 60_000,
          message: 'the task on hub B'
        })
        .toBe(targetProjectId)
      await expect.poll(() => projectOnAppHub(page, taskId), { timeout: 30_000 }).toBe(null)
      await expect(page.getByTestId('task-moves-panel')).toHaveCount(0, { timeout: 30_000 })

      // The app's hub never told its computer to erase the chat or refuse the task.
      expect(
        await hubDbAll(app, 'SELECT * FROM chat_deletion_targets WHERE conversation_id = ?', [
          conversationId
        ])
      ).toEqual([])
      expect(
        await hubDbAll(app, 'SELECT * FROM chat_task_lifecycle WHERE task_id = ?', [taskId])
      ).toEqual([])

      // And back.
      await openMoveDialog(page, 'TA', 'Chat mover', /Source On A/)
      await confirmMove(page)
      await expect
        .poll(() => projectOnAppHub(page, taskId), {
          timeout: 60_000,
          message: 'the task back on the app hub'
        })
        .toBe(sourceProjectId)
      await expect(page.getByTestId('task-moves-panel')).toHaveCount(0, { timeout: 30_000 })

      // The chat opens with what it held before the move.
      await expect
        .poll(
          async () =>
            (await readChatEvents(page, tabId).catch((e: Error) => [e.message])).map((e) =>
              typeof e === 'string' ? e : e.event.kind
            ),
          { timeout: 30_000, message: 'the chat on the app computer again' }
        )
        .toEqual(['user-message'])
    } finally {
      if (launched) await launched.close()
      if (hub) await hub.stop()
      fs.rmSync(store, { recursive: true, force: true })
    }
  })

  /**
   * Pause, resume and cancel work on the journal, so these tests start a move by the
   * hub's own procedures and leave nobody driving it: the app finds it at load, as it
   * would a move another device (or an earlier run) left behind.
   */
  base('a paused move locks its task; resume finishes it', async () => {
    base.setTimeout(240_000)
    await inTwoHubs('pause', async ({ page, targetProjectId, hub }) => {
      const projectId = await projectOnA(page, 'Source On A')
      const taskId = await createTaskOnA(page, projectId, 'Paused mover')
      const moveId = await beginMove(page, [taskId], targetProjectId)
      await pauseMove(page, moveId)
      await page.reload()
      await page.waitForSelector('#root', { timeout: 30_000 })

      // The app lists it as paused, the board marks the task, and the task refuses edits.
      const card = page.getByTestId(`task-move-${moveId}`)
      await expect(card).toHaveAttribute('data-status', 'paused', { timeout: 30_000 })
      await expect(card.getByText('Paused')).toBeVisible()
      await clickProject(page, 'SO')
      await expect(page.getByTestId('task-moving-mark')).toBeVisible({ timeout: 20_000 })
      expect(await editTitle(page, taskId, 'edited while moving')).toMatch(/being moved/)
      expect(await tasksOnB(hub)).not.toContainEqual(expect.objectContaining({ id: taskId }))

      // Resume runs the rest to the end.
      await card.getByRole('button', { name: 'Resume' }).click()
      await expect
        .poll(async () => (await tasksOnB(hub)).find((t) => t.id === taskId)?.project_id, {
          timeout: 60_000,
          message: 'the resumed move lands the task on hub B'
        })
        .toBe(targetProjectId)
      await expect.poll(() => projectOnAppHub(page, taskId), { timeout: 30_000 }).toBe(null)
      await expect(page.getByTestId('task-moves-panel')).toHaveCount(0, { timeout: 30_000 })
    })
  })

  base('a canceled move unlocks its task, which stays here with its chat', async () => {
    base.setTimeout(240_000)
    await inTwoHubs('cancel', async ({ page, launched, targetProjectId, hub }) => {
      const projectId = await projectOnA(page, 'Source On A')
      const taskId = await createTaskOnA(page, projectId, 'Canceled mover', {
        agentId: 'claude-chat'
      })
      const tabId = await page.evaluate(async (id) => {
        const tab = await window
          .getTrpcVanillaClient()
          .taskTerminals.ensureMain.mutate({ taskId: id, mode: 'claude-chat' })
        return tab.id
      }, taskId)
      await seedChatEvents(page, tabId, [{ kind: 'user-message', id: 'u1', text: 'before' }])
      const moveId = await beginMove(page, [taskId], targetProjectId)
      await pauseMove(page, moveId)
      await page.reload()
      await page.waitForSelector('#root', { timeout: 30_000 })

      const card = page.getByTestId(`task-move-${moveId}`)
      await expect(card).toHaveAttribute('data-status', 'paused', { timeout: 30_000 })
      await card.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByTestId('task-moves-panel')).toHaveCount(0, { timeout: 30_000 })

      // Still here, editable, its chat as it was; nothing reached hub B.
      expect(await editTitle(page, taskId, 'Canceled mover, edited')).toBe('written')
      expect(await projectOnAppHub(page, taskId)).toBe(projectId)
      expect((await readChatEvents(page, tabId)).map((e) => e.event.kind)).toEqual(['user-message'])
      expect(
        await hubDbAll(launched.app, 'SELECT state FROM chat_ownership WHERE task_id = ?', [taskId])
      ).toEqual([{ state: 'active' }])
      expect(await tasksOnB(hub)).not.toContainEqual(expect.objectContaining({ id: taskId }))
    })
  })

  base('a move interrupted by quitting the app is finished at the next start', async () => {
    base.setTimeout(300_000)
    await inTwoHubs('quit', async (env) => {
      const { page, hub, targetProjectId } = env
      const projectId = await projectOnA(page, 'Source On A')
      const taskId = await createTaskOnA(page, projectId, 'Interrupted mover')
      const moveId = await beginMove(page, [taskId], targetProjectId)
      // The app quits mid-move: the journal says running, and has been quiet a while.
      await hubDbRun(env.launched.app, 'UPDATE task_moves SET updated_at = ? WHERE id = ?', [
        Date.now() - 5 * 60_000,
        moveId
      ])
      const { userDataDir } = env.launched
      await env.launched.close()

      const relaunched = await launchIsolatedElectron({
        name: 'move-task-quit-relaunch',
        userDataDir,
        extraEnv: (dir) => ({ SLAYZONE_ROOT: dir })
      })
      // inTwoHubs closes the first launch again (harmless); this one is closed here.
      try {
        await relaunched.page.waitForSelector('#root', { timeout: 30_000 })
        expect(await waitForUsableComputer(relaunched.page), 'local computer up').toBe(true)
        await expect
          .poll(async () => (await tasksOnB(hub)).find((t) => t.id === taskId)?.project_id, {
            timeout: 90_000,
            message: 'the interrupted move finishes on hub B after the restart'
          })
          .toBe(targetProjectId)
        await expect
          .poll(() => projectOnAppHub(relaunched.page, taskId), { timeout: 30_000 })
          .toBe(null)
      } finally {
        await relaunched.close()
      }
    })
  })

  base('a task moves with its artifact file; a blocker left behind becomes a link', async () => {
    base.setTimeout(300_000)
    await inTwoHubs('carry', async ({ page, hub, targetProjectId }) => {
      const projectId = await projectOnA(page, 'Source On A')
      const moved = await createTaskOnA(page, projectId, 'Carrier')
      const stays = await createTaskOnA(page, projectId, 'Left behind')
      // Over two 512 KB chunks, so the copy is chunked and its hash checked.
      const body = `start-${'x'.repeat(1_200_000)}-end`
      const artifactId = await page.evaluate(
        async ({ moved, stays, body }) => {
          const c = window.getTrpcVanillaClient()
          await c.task.addBlocker.mutate({ taskId: moved, blockerTaskId: stays })
          const artifact = await c.artifacts.create.mutate({
            taskId: moved,
            title: 'notes.md',
            content: body
          })
          return artifact!.id
        },
        { moved, stays, body }
      )
      await page.reload()
      await page.waitForSelector('#root', { timeout: 30_000 })

      await openMoveDialog(page, 'SO', 'Carrier', /Target On B/)
      await confirmMove(page)
      await expect
        .poll(async () => (await tasksOnB(hub)).find((t) => t.id === moved)?.project_id, {
          timeout: 90_000,
          message: 'the task on hub B'
        })
        .toBe(targetProjectId)
      await expect(page.getByTestId('task-moves-panel')).toHaveCount(0, { timeout: 30_000 })

      // The file arrived whole, under the same artifact id.
      const onB = await withHubClient(hub, async (c) => ({
        list: (await c.artifacts.getByTask.query({ taskId: moved })) as Array<{
          id: string
          title: string
        }>,
        content: (await c.artifacts.readContent.query({ id: artifactId })) as string | null,
        links: (await c.taskMoves.remoteBlockers.query({ taskId: moved })) as Array<{
          role: string
          remoteTaskId: string
        }>
      }))
      expect(onB.list.map((a) => [a.id, a.title])).toEqual([[artifactId, 'notes.md']])
      expect(onB.content).toBe(body)
      // The blocker stayed a link on both hubs: each side names the other task.
      expect(onB.links).toEqual([
        expect.objectContaining({ role: 'blocked_by', remoteTaskId: stays })
      ])
      const onA = await page.evaluate(
        (id) => window.getTrpcVanillaClient().taskMoves.remoteBlockers.query({ taskId: id }),
        stays
      )
      expect(onA).toEqual([expect.objectContaining({ role: 'blocks', remoteTaskId: moved })])
    })
  })
})
