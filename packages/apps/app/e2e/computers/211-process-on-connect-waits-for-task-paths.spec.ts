/**
 * A worktree task's background process started while the computer is still
 * connecting runs in the task's worktree, not refused (review 2, S3).
 *
 * After an upgrade the task's worktree path is staged on the hub (v210/v211) and
 * reaches the computer by the reconnect handoff, which runs after the computer's
 * projects, recovery and lifecycle passes. A process asked to start before that
 * (Start clicked during boot; an auto-restart process waiting for a computer is
 * spawned by `processesComputerConnected` the moment the computer connects) used to
 * reach the computer first: the worktree was not yet one of the task's folders there,
 * so the computer's path scope refused the spawn and the process showed an error.
 * Every task-scoped request now waits for the task's staged `task-path` row
 * (hub `task-path-request-gate`, the gateway's `beforeRequest`).
 *
 * Boots the app on a hub database exactly as 0.36.2 left it (real migrations up to
 * v171), like spec 210, and asks for the start before waiting for the computer.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { test, expect, launchIsolatedElectron, waitForUsableComputer } from '../fixtures/electron'
import { writeReleasedHubDb } from '../fixtures/released-hub-db'

/** The desktop app's own computer: a fixed id 0.36 enrolled it under too. */
const LOCAL_COMPUTER = 'f01a216a-4803-4214-98eb-f9e28951e1bb'
const PROJECT = 'p-on-connect'
const WORKTREE_TASK = 't-on-connect-worktree'
const PROCESS = 'proc-on-connect-worktree'

type ProcRow = { id: string; status: string; logBuffer: string[] }

test('a worktree task’s process started during boot runs once the computer connects', async () => {
  test.setTimeout(240_000)
  const folders = { project: '', worktree: '' }
  const app = await launchIsolatedElectron({
    name: 'process-on-connect-waits-for-task-paths',
    seedUserData: (dir) => {
      const folder = (name: string): string => {
        const p = path.join(dir, 'projects', name)
        mkdirSync(p, { recursive: true })
        return p
      }
      folders.project = folder('repo')
      folders.worktree = folder('repo-workspaces/feature')
      const hubDir = path.join(dir, 'dev', 'hub')
      mkdirSync(hubDir, { recursive: true })
      writeReleasedHubDb(path.join(hubDir, 'slayzone.dev.data.sqlite'), 'v0.36.2', (db) => {
        db.prepare(
          `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at)
           VALUES (?, 'local-computer', ?, '0.36.2', '[]', 1)`
        ).run(LOCAL_COMPUTER, `${process.platform}-${process.arch}`)
        db.prepare(
          `INSERT INTO projects (id, name, color, path, sort_order) VALUES (?, 'On connect', '#0ea5e9', ?, 0)`
        ).run(PROJECT, folders.project)
        db.prepare(
          `INSERT INTO tasks (id, project_id, title, status, terminal_mode, worktree_path, base_dir,
             claude_conversation_id, provider_config)
           VALUES (?, ?, 'Works in a worktree', 'in_progress', 'claude-code', ?, NULL, NULL, '{}')`
        ).run(WORKTREE_TASK, PROJECT, folders.worktree)
        // Auto-restart: one that found no computer is spawned the moment one connects.
        db.prepare(
          `INSERT INTO processes (id, task_id, project_id, label, command, cwd, auto_restart)
           VALUES (?, ?, ?, 'Worktree dev server', 'pwd; echo on-connect-ok; sleep 120', ?, 1)`
        ).run(PROCESS, WORKTREE_TASK, PROJECT, folders.worktree)
      })
    }
  })
  try {
    const page = app.page
    // Asked before the computer is usable (and before the reconnect handoff ran).
    await expect(async () => {
      await page.evaluate(
        (processId) => window.getTrpcVanillaClient().processes.restart.mutate({ processId }),
        PROCESS
      )
    }).toPass({ timeout: 30_000 })
    expect(await waitForUsableComputer(page)).toBe(true)

    // It runs (the computer's path scope accepted the worktree as the task's folder),
    // without a second Start, in the worktree, and nothing was refused on the way.
    const row = async (): Promise<ProcRow | undefined> =>
      (
        (await page.evaluate(() =>
          window.getTrpcVanillaClient().processes.listAll.query()
        )) as ProcRow[]
      ).find((p) => p.id === PROCESS)
    await expect.poll(async () => (await row())?.status, { timeout: 60_000 }).toBe('running')
    await expect
      .poll(async () => (await row())?.logBuffer.join('\n') ?? '', { timeout: 30_000 })
      .toContain('on-connect-ok')
    const logs = (await row())?.logBuffer.join('\n') ?? ''
    expect(logs).toContain(folders.worktree)
    expect(logs).not.toMatch(/refus|outside|not one of/i)

    await page.evaluate(
      (processId) => window.getTrpcVanillaClient().processes.remove.mutate({ processId }),
      PROCESS
    )
  } finally {
    await app.close()
  }
})
