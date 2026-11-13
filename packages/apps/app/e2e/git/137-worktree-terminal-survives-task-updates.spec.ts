/**
 * B2: an update to a worktree task that does not touch its folder — a status change,
 * a rename, the version bump every write makes — must NEVER unmount its terminal.
 * The task's paths were keyed on the row's version, so each update answered
 * "loading", the page swapped the terminal for "Loading the task folder…" and then
 * mounted a NEW one (xterm rebuilt, flash). Here the terminal's DOM node is tagged
 * before the updates and must be the very same node after them, with its shell
 * session (and its output) untouched.
 */
import {
  test,
  expect,
  seed,
  resetApp,
  createIsolatedGitRepo,
  openTaskByTitle
} from '../fixtures/electron'
import {
  getMainSessionId,
  readFullBuffer,
  runCommand,
  waitForBufferContains,
  waitForPtySession
} from '../fixtures/terminal'
import { execSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import path from 'path'

let gitDir: string
let worktreePath: string

function git(cmd: string, cwd = gitDir) {
  return execSync(cmd.replace(/^git /, 'git -c commit.gpgsign=false '), {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe'
  })
}

test.describe('Worktree task terminal survives task updates (B2)', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    gitDir = createIsolatedGitRepo('b2-terminal-survives')
    const worktrees = path.join(gitDir, 'worktrees')
    worktreePath = path.join(worktrees, 'b2-branch')
    try {
      git(`git worktree remove --force "${worktreePath}"`)
    } catch {
      /* none yet */
    }
    rmSync(worktrees, { recursive: true, force: true })
    try {
      git('git worktree prune')
      git('git branch -D b2-branch')
    } catch {
      /* none yet */
    }
    writeFileSync(path.join(gitDir, 'base.txt'), 'baseline\n')
    git('git add base.txt')
    try {
      git('git commit -m baseline')
    } catch {
      /* already committed */
    }
    mkdirSync(worktrees, { recursive: true })
    git(`git worktree add -b b2-branch "${worktreePath}"`)

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'B2 Survive', color: '#0ea5e9', path: gitDir })
    const t = await s.createTask({
      projectId: p.id,
      title: 'B2 worktree task',
      status: 'in_progress'
    })
    taskId = t.id
    // A plain shell (no Start gate) running in the task's worktree.
    await mainWindow.evaluate((d) => window.getTrpcVanillaClient().task.update.mutate(d), {
      id: taskId,
      agentId: 'terminal',
      worktreePath
    })
    await s.refreshData()
  })

  test.afterAll(() => {
    try {
      git(`git worktree remove --force "${worktreePath}"`)
      git('git worktree prune')
    } catch {
      /* ignore */
    }
  })

  test('status, title and version updates keep the SAME terminal node and session', async ({
    mainWindow
  }) => {
    await openTaskByTitle(mainWindow, 'B2 worktree task')
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)
    const marker = `B2_${Date.now()}`
    await runCommand(mainWindow, sessionId, `echo ${marker} && pwd`)
    await waitForBufferContains(mainWindow, sessionId, marker)
    // It runs in the worktree, not the project folder.
    await waitForBufferContains(mainWindow, sessionId, 'b2-branch')

    // Tag the live terminal node (attribute + a JS reference to the element itself).
    const xterm = mainWindow.locator('.xterm:visible').first()
    await expect(xterm).toBeVisible()
    await xterm.evaluate((el) => {
      el.setAttribute('data-b2-marker', 'before-updates')
      ;(window as unknown as { __b2Node?: Element }).__b2Node = el
    })

    const update = (d: Record<string, unknown>) =>
      mainWindow.evaluate((input) => window.getTrpcVanillaClient().task.update.mutate(input), {
        id: taskId,
        ...d
      })
    // What a kanban move, an agent's `slay tasks update` and a rename do.
    await update({ status: 'review' })
    await update({ title: 'B2 worktree task (renamed)' })
    await update({ status: 'in_progress' })
    await update({ priority: 1 })
    // Each write reaches this window (notify.onTasksChanged): wait for the rename.
    await expect
      .poll(() =>
        mainWindow.evaluate(() =>
          [...document.querySelectorAll('input')].some(
            (el) => el.value === 'B2 worktree task (renamed)'
          )
        )
      )
      .toBe(true)
    // Several board refresh / path-read cycles.
    await mainWindow.waitForTimeout(1_500)

    // Never the folder placeholder, and the very same node.
    await expect(mainWindow.getByText('Loading the task folder…')).toHaveCount(0)
    await expect(mainWindow.getByText(/connect it to start/)).toHaveCount(0)
    const same = await mainWindow.evaluate(() => {
      const node = (window as unknown as { __b2Node?: Element }).__b2Node
      return {
        connected: !!node?.isConnected,
        marker: node?.getAttribute('data-b2-marker') ?? null,
        stillVisibleXterm: [...document.querySelectorAll('.xterm')].some(
          (el) => el === node && (el as HTMLElement).offsetParent !== null
        )
      }
    })
    expect(same).toEqual({ connected: true, marker: 'before-updates', stillVisibleXterm: true })
    await expect(mainWindow.locator('.xterm[data-b2-marker="before-updates"]:visible')).toHaveCount(
      1
    )

    // The shell session was never restarted: the output from before is still there.
    await waitForPtySession(mainWindow, sessionId)
    expect(await readFullBuffer(mainWindow, sessionId)).toContain(marker)
  })
})
