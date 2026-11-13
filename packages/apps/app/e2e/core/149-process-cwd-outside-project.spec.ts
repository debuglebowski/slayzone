/**
 * Review 2, B3 (a): a background process's working folder is the user's. A task's
 * process set to run in a sibling repo (`~/backend`, outside the project folder)
 * starts THERE: the computer takes that folder as a declared root of the spawn,
 * judged by its machine bound only. Before, its scope jail refused it ("…is outside
 * the folders of task <uuid>; refused") and the process never started.
 *
 * A project's process runs in the project's folder on its computer (a project has
 * one folder per computer; its row's folder names no particular machine), as it
 * always did: it starts too.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'fs'
import path from 'path'
import { test, expect, seed, resetApp, createIsolatedGitRepo } from '../fixtures/electron'

test.describe('A process whose folder is outside its project starts (B3)', () => {
  let projectDir: string
  let backend: string
  let projectId: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    projectDir = createIsolatedGitRepo('b3-process-cwd')
    // A sibling repo beside the project folder, not inside it.
    backend = path.join(path.dirname(projectDir), 'b3-backend')
    rmSync(backend, { recursive: true, force: true })
    mkdirSync(backend, { recursive: true })
    const s = seed(mainWindow)
    projectId = (await s.createProject({ name: 'B3 Proc', color: '#f97316', path: projectDir })).id
    taskId = (await s.createTask({ projectId, title: 'B3 process task', status: 'in_progress' })).id
    await s.refreshData()
  })

  test.afterAll(() => rmSync(backend, { recursive: true, force: true }))

  const spawn = (
    page: import('@playwright/test').Page,
    input: { projectId: string | null; taskId: string | null; cwd: string; out: string }
  ) =>
    page.evaluate(
      (i) =>
        window.getTrpcVanillaClient().processes.spawn.mutate({
          projectId: i.projectId,
          taskId: i.taskId,
          label: 'b3-pwd',
          command: `pwd > "${i.out}"`,
          cwd: i.cwd,
          autoRestart: false
        }),
      input
    )

  test("a task's process starts in its own folder outside the project", async ({ mainWindow }) => {
    const out = path.join(backend, 'task-pwd.txt')
    await spawn(mainWindow, { projectId: null, taskId, cwd: backend, out })
    await expect.poll(() => existsSync(out), { timeout: 30_000 }).toBe(true)
    expect(realpathSync(readFileSync(out, 'utf8').trim())).toBe(realpathSync(backend))
    // Never refused by the computer's jail.
    const rows = await mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().processes.listAll.query()
    )
    const row = (rows as Array<{ taskId: string | null; logBuffer?: string[] }>).find(
      (r) => r.taskId === taskId
    )
    expect((row?.logBuffer ?? []).join('\n')).not.toMatch(/refused/)
  })

  test("a project's process starts, in the project's folder", async ({ mainWindow }) => {
    const out = path.join(backend, 'project-pwd.txt')
    await spawn(mainWindow, { projectId, taskId: null, cwd: backend, out })
    await expect.poll(() => existsSync(out), { timeout: 30_000 }).toBe(true)
    expect(realpathSync(readFileSync(out, 'utf8').trim())).toBe(realpathSync(projectDir))
  })
})
