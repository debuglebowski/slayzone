/**
 * A project's folder lives on a computer, not on the hub.
 *
 * A project needs no folder to exist. Its agents do: with none on the task's
 * computer the task page asks for one ("Pick folder") instead of starting an
 * agent somewhere else. The folder is recorded on that computer — the hub's copy
 * says so — and the terminal then starts in it. (The computer's own refusal of a
 * folderless spawn, `project-not-placed`, is unit-tested at each layer.)
 *
 * Uses a custom AI-labelled mode with no initial command, so the "agent" is a
 * plain shell the test can ask `pwd`.
 */
import { realpathSync } from 'node:fs'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  runCommand,
  waitForBufferContains,
  waitForPtySession
} from '../fixtures/terminal'

const modeId = 'project-folder-e2e'

test.describe('Project folder per computer', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    // Mounts spawn directly (no idle gate) — the gate is not this spec's subject.
    await mainWindow.evaluate(() =>
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_agent_startup', value: 'instant' })
    )
    await mainWindow.evaluate(
      (id) =>
        window.getTrpcVanillaClient().pty.modesCreate.mutate({
          id,
          label: 'Project Folder E2E',
          type: 'claude-code',
          initialCommand: null,
          resumeCommand: null,
          defaultFlags: '',
          enabled: true,
          order: 999
        }),
      modeId
    )
  })

  test.afterAll(async ({ mainWindow }) => {
    await mainWindow
      .evaluate((id) => window.getTrpcVanillaClient().pty.modesDelete.mutate({ id }), modeId)
      .catch(() => {})
    await mainWindow
      .evaluate(() =>
        window
          .getTrpcVanillaClient()
          .settings.set.mutate({ key: 'terminal_agent_startup', value: 'manual' })
      )
      .catch(() => {})
  })

  test('no folder → the task asks for one; picked → recorded on the computer, agent starts there', async ({
    mainWindow,
    electronApp
  }) => {
    const s = seed(mainWindow)

    // A project without a folder is a normal project, with a computer of its own.
    const project = await s.createProject({ name: 'NoFolder', color: '#0ea5e9' })
    expect(project.placements).toEqual([])
    expect(project.resolved_computer_id).toBeTruthy()

    const task = await s.createTask({
      projectId: project.id,
      title: 'Folderless task',
      status: 'in_progress'
    })
    await mainWindow.evaluate(
      ({ id, m }) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: m }),
      { id: task.id, m: modeId }
    )
    await s.refreshData()
    // Opened by id, like openTaskById — but that helper waits for a terminal, and
    // with no folder the task shows a prompt instead.
    // No folder anywhere: the same words the desktop app always showed.
    const prompt = mainWindow.getByText('No repository path configured')
    await expect(async () => {
      await mainWindow.evaluate((id) => {
        const open = (window as Window & { __slayzone_openTask?: (i: string) => void })
          .__slayzone_openTask
        if (!open) throw new Error('__slayzone_openTask not exposed yet')
        open(id)
      }, task.id)
      await expect(prompt.last()).toBeVisible({ timeout: 5_000 })
    }).toPass({ timeout: 20_000 })
    await expect(mainWindow.getByTestId('pick-project-folder').last()).toBeVisible()

    // With a folder on another computer (only possible with several), the page says
    // what is really missing: one on THIS task's computer.
    const hubExec = (sql: string) =>
      electronApp.evaluate(async (_electron, q) => {
        const db = (globalThis as Record<string, unknown>).__db as {
          exec: (sql: string) => Promise<unknown>
        }
        await db.exec(q)
      }, sql)
    await hubExec(
      `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
       VALUES ('e2e-other-computer', '${project.id}', '/elsewhere', 'ready', 1)`
    )
    await s.refreshData()
    await expect(
      mainWindow.getByText('This project has no folder on this task’s computer').last()
    ).toBeVisible({ timeout: 10_000 })
    await hubExec(`DELETE FROM project_placements WHERE computer_id = 'e2e-other-computer'`)
    await s.refreshData()

    // What the picker's choice does: recorded on the task's computer.
    await mainWindow.evaluate(
      ({ taskId, projectId, path }) =>
        window.getTrpcVanillaClient().workspace.setProjectPath.mutate({ taskId, projectId, path }),
      { taskId: task.id, projectId: project.id, path: TEST_PROJECT_PATH }
    )
    await expect
      .poll(
        async () =>
          (await s.getProjects()).find((p) => p.id === project.id)?.placements.map((p) => p.status),
        { timeout: 10_000 }
      )
      .toEqual(['ready'])

    const sessionId = getMainSessionId(task.id)
    await waitForPtySession(mainWindow, sessionId)
    await runCommand(mainWindow, sessionId, 'pwd -P')
    await waitForBufferContains(mainWindow, sessionId, realpathSync(TEST_PROJECT_PATH))
  })
})
