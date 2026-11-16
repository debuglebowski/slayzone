/**
 * Review 2, B3: "Change working directory" sends the chosen folder to the task's
 * computer FIRST; its path jail judges it before anything is written. A refusal (here
 * a folder outside the computer's allowed folders) shows the error and leaves the
 * running terminal exactly as it was — same DOM node, same shell session, old folder.
 * Before, the picker killed the main PTY before the update, so a refusal left a dead
 * terminal and the old folder.
 *
 * Then an accepted folder (a sibling repo outside the project — B3 (b)/(c): a folder
 * the user chose is the task's declared root) restarts the terminal there.
 */
import { mkdirSync, rmSync } from 'fs'
import path from 'path'
import {
  test,
  expect,
  seed,
  resetApp,
  createIsolatedGitRepo,
  openTaskById,
  taskWithPaths
} from '../fixtures/electron'
import {
  getMainSessionId,
  readFullBuffer,
  runCommand,
  waitForBufferContains,
  waitForPtySession
} from '../fixtures/terminal'

const PANELS = {
  terminal: true,
  browser: false,
  diff: false,
  settings: true,
  editor: false,
  artifacts: false,
  processes: false
}

test.describe('Custom folder: a refused folder keeps the running terminal (B3)', () => {
  let projectDir: string
  let sibling: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    projectDir = createIsolatedGitRepo('b3-custom-folder')
    sibling = path.join(path.dirname(projectDir), 'b3-custom-sibling')
    rmSync(sibling, { recursive: true, force: true })
    mkdirSync(sibling, { recursive: true })
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'B3 Folder', color: '#a855f7', path: projectDir })
    taskId = (
      await s.createTask({ projectId: p.id, title: 'B3 custom folder task', status: 'in_progress' })
    ).id
    // A plain shell (no Start gate) with the task's settings beside it.
    await s.updateTask({ id: taskId, agentId: 'terminal', panelVisibility: PANELS })
    await s.refreshData()
  })

  test.afterAll(() => rmSync(sibling, { recursive: true, force: true }))

  const pick = async (page: import('@playwright/test').Page, folder: string) => {
    await page.locator('button[title="Change working directory"]:visible').first().click()
    const picker = page.locator('[data-testid="workspace-dir-picker"]')
    await expect(picker).toBeVisible({ timeout: 10_000 })
    await picker.locator('[data-testid="workspace-dir-picker-path"]').fill(folder)
    await picker.locator('[data-testid="workspace-dir-picker-select"]').click()
  }

  test('a refused folder: error shown, same terminal node and session, folder unchanged', async ({
    mainWindow
  }) => {
    await openTaskById(mainWindow, taskId)
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)
    const marker = `B3_${Date.now()}`
    await runCommand(mainWindow, sessionId, `echo ${marker}`)
    await waitForBufferContains(mainWindow, sessionId, marker)
    const xterm = mainWindow.locator('.xterm:visible').first()
    await expect(xterm).toBeVisible()
    await xterm.evaluate((el) => {
      ;(window as unknown as { __b3Node?: Element }).__b3Node = el
    })

    // Outside every folder the computer allows: its jail refuses it.
    await pick(mainWindow, '/etc')
    await expect(mainWindow.getByText("Couldn't use that folder")).toBeVisible({ timeout: 15_000 })
    await mainWindow.waitForTimeout(1_500)

    const same = await mainWindow.evaluate(() => {
      const node = (window as unknown as { __b3Node?: Element }).__b3Node
      return !!node?.isConnected && (node as HTMLElement).offsetParent !== null
    })
    expect(same).toBe(true)
    await waitForPtySession(mainWindow, sessionId)
    expect(await readFullBuffer(mainWindow, sessionId)).toContain(marker)
    const task = await taskWithPaths(mainWindow, taskId)
    expect(task?.has_base_dir).toBeFalsy()
    expect(task?.base_dir ?? null).toBeNull()
  })

  test('an accepted folder outside the project: the terminal restarts there', async ({
    mainWindow
  }) => {
    await openTaskById(mainWindow, taskId)
    await pick(mainWindow, sibling)
    await expect
      .poll(async () => (await taskWithPaths(mainWindow, taskId))?.base_dir, {
        timeout: 15_000
      })
      .toBe(sibling)
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)
    // The saved folder changes before the replacement shell finishes starting.
    // Existence can still describe the old PTY; retry a harmless command until
    // the NEW shell executes it. Neither the command echo nor its prompt can
    // satisfy this marker + actual working-directory check.
    const marker = `B3_CWD_${Date.now()}:`
    await expect
      .poll(
        async () => {
          await runCommand(mainWindow, sessionId, `printf '${marker}%s\\n' "$PWD"`)
          return (await readFullBuffer(mainWindow, sessionId)).includes(`${marker}${sibling}`)
        },
        { timeout: 10_000 }
      )
      .toBe(true)
  })
})
