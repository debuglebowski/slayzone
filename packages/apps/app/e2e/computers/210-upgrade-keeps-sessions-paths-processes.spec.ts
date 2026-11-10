/**
 * Upgrading from 0.36.2 keeps what a user's tasks were doing, with nothing to do:
 *   - a task's agent session resumes (the hub's ledger rows, handed to the computer);
 *   - a worktree task and a custom-folder task still name their folders (the hub's
 *     paths, handed to the computer that now holds them);
 *   - background processes start: a global one (no task, no project) and a task one
 *     stored with no project id (the Processes dialog's "Task" scope; one exists on
 *     a production copy).
 *
 * Boots the app on a hub database exactly as 0.36.2 left it (real migrations up to
 * v171, 0.36-shaped rows), so v172..latest and every hand-off to the local computer
 * run as on a user's machine.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, launchIsolatedElectron, waitForUsableComputer } from '../fixtures/electron'
import { startAgentTerminal } from '../fixtures/terminal'
import { writeReleasedHubDb } from '../fixtures/released-hub-db'

/** The desktop app's own computer: a fixed id 0.36 enrolled it under too. */
const LOCAL_COMPUTER = 'f01a216a-4803-4214-98eb-f9e28951e1bb'
const PROJECT = 'p-upgrade'
const RESUME_TASK = 't-resume'
const WORKTREE_TASK = 't-worktree'
const BASE_DIR_TASK = 't-base-dir'
const SESSION = 'a0a0a0a0-1111-4222-8333-944444444444'

async function openTask(page: Page, taskId: string): Promise<void> {
  await expect(async () => {
    await page.evaluate((id) => {
      const open = (window as Window & { __slayzone_openTask?: (i: string) => void })
        .__slayzone_openTask
      if (!open) throw new Error('__slayzone_openTask not exposed yet')
      open(id)
    }, taskId)
  }).toPass({ timeout: 20_000 })
}

test('upgrade from 0.36.2: sessions resume, task folders stay, processes start', async () => {
  test.setTimeout(240_000)
  const folders = { project: '', worktree: '', baseDir: '' }
  const app = await launchIsolatedElectron({
    name: 'upgrade-keeps-sessions-paths-processes',
    seedUserData: (dir) => {
      const folder = (name: string): string => {
        const p = path.join(dir, 'projects', name)
        mkdirSync(p, { recursive: true })
        return p
      }
      folders.project = folder('repo')
      folders.worktree = folder('repo-workspaces/feature')
      folders.baseDir = folder('repo/packages/api')
      const hubDir = path.join(dir, 'dev', 'hub')
      mkdirSync(hubDir, { recursive: true })
      writeReleasedHubDb(path.join(hubDir, 'slayzone.dev.data.sqlite'), 'v0.36.2', (db) => {
        db.prepare(
          `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at)
           VALUES (?, 'local-computer', ?, '0.36.2', '[]', 1)`
        ).run(LOCAL_COMPUTER, `${process.platform}-${process.arch}`)
        db.prepare(
          `INSERT INTO projects (id, name, color, path, sort_order) VALUES (?, 'Upgrade', '#0ea5e9', ?, 0)`
        ).run(PROJECT, folders.project)
        const task = db.prepare(
          `INSERT INTO tasks (id, project_id, title, status, terminal_mode, worktree_path, base_dir,
             claude_conversation_id, provider_config)
           VALUES (?, ?, ?, 'in_progress', 'claude-code', ?, ?, ?, ?)`
        )
        task.run(
          RESUME_TASK,
          PROJECT,
          'Resumes its session',
          null,
          null,
          SESSION,
          JSON.stringify({ 'claude-code': { conversationId: SESSION } })
        )
        task.run(WORKTREE_TASK, PROJECT, 'Works in a worktree', folders.worktree, null, null, '{}')
        task.run(
          BASE_DIR_TASK,
          PROJECT,
          'Works in a custom folder',
          null,
          folders.baseDir,
          null,
          '{}'
        )
        // The session as 0.36's ledger recorded it, with its first turn (resumable).
        db.prepare(
          `INSERT INTO task_conversations (id, task_id, mode, conversation_id, origin, created_at)
           VALUES ('tc-upgrade', ?, 'claude-code', ?, 'slay-spawned-fresh', 1000)`
        ).run(RESUME_TASK, SESSION)
        db.prepare(
          `INSERT INTO agent_sessions (id, mode, cwd, task_id, conversation_id, origin, status, created_at, bound_at)
           VALUES ('as-upgrade', 'claude-code', ?, ?, ?, 'slay-spawned-fresh', 'bound', 1000, 1000)`
        ).run(folders.project, RESUME_TASK, SESSION)
        db.prepare(
          'INSERT INTO session_turns (conversation_id, first_turn_at) VALUES (?, 1001)'
        ).run(SESSION)
        const proc = db.prepare(
          `INSERT INTO processes (id, task_id, project_id, label, command, cwd, auto_restart)
           VALUES (?, ?, ?, ?, ?, ?, 0)`
        )
        proc.run('proc-global', null, null, 'Global', 'echo upgrade-global-ok; sleep 120', '')
        proc.run(
          'proc-task',
          BASE_DIR_TASK,
          null,
          'Task scoped',
          'echo upgrade-task-ok; sleep 120',
          folders.project
        )
      })
    }
  })
  try {
    const page = app.page
    expect(await waitForUsableComputer(page)).toBe(true)

    // Paths: the computer holding the tasks' folders answers them.
    await expect
      .poll(
        () =>
          page.evaluate(
            (ids) => window.getTrpcVanillaClient().task.paths.query({ taskIds: ids }),
            [WORKTREE_TASK, BASE_DIR_TASK]
          ),
        { timeout: 60_000 }
      )
      .toEqual({
        [WORKTREE_TASK]: { state: 'ok', worktreePath: folders.worktree, baseDir: null },
        [BASE_DIR_TASK]: { state: 'ok', worktreePath: null, baseDir: folders.baseDir }
      })

    // Processes: both start (neither is refused by the computer's path scope).
    for (const id of ['proc-global', 'proc-task'])
      await page.evaluate(
        (processId) => window.getTrpcVanillaClient().processes.restart.mutate({ processId }),
        id
      )
    await expect
      .poll(
        async () =>
          Object.fromEntries(
            (
              (await page.evaluate(() =>
                window.getTrpcVanillaClient().processes.listAll.query()
              )) as Array<{ id: string; status: string }>
            )
              .filter((p) => p.id.startsWith('proc-'))
              .map((p) => [p.id, p.status])
          ),
        { timeout: 60_000 }
      )
      .toEqual({ 'proc-global': 'running', 'proc-task': 'running' })

    // Resume: the task's agent resumes the session 0.36 recorded.
    await page.evaluate(() =>
      window.getTrpcVanillaClient().pty.testSetPtyCreateCapture.mutate({ enabled: true })
    )
    await openTask(page, RESUME_TASK)
    await startAgentTerminal(page)
    await expect
      .poll(
        async () => {
          const all = (await page.evaluate(() =>
            window.getTrpcVanillaClient().pty.testTakePtyCreateOpts.query()
          )) as Array<{ sessionId: string; resumeConversationId?: string | null }>
          return all.find((o) => o.sessionId.startsWith(RESUME_TASK))?.resumeConversationId
        },
        { timeout: 60_000 }
      )
      .toBe(SESSION)

    for (const id of ['proc-global', 'proc-task'])
      await page.evaluate(
        (processId) => window.getTrpcVanillaClient().processes.remove.mutate({ processId }),
        id
      )
  } finally {
    await app.close()
  }
})
