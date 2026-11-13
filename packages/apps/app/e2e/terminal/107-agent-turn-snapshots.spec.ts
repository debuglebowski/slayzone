/**
 * An agent terminal's submitted prompt records a turn snapshot.
 *
 * Regression (QA 2026-11-06, task 964073b0 "agent-turn snapshots" → 5decc957):
 * daf8d3bb4 (2026-08-06) dropped the only callers of the turn subscribers, so no
 * turn was ever recorded — the Git panel's turn selector stayed empty and
 * `refs/slayzone/turns` got nothing. A custom AI mode with no command runs a plain
 * shell in an AGENT tab (a plain `terminal` tab records no turns by design), so a
 * submitted line is a turn boundary without a real agent CLI.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { test, expect, seed, resetApp, createIsolatedGitRepo } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal,
  runCommand,
  waitForBufferContains,
  waitForPtySession
} from '../fixtures/terminal'

const MODE = 'turn-snapshots-e2e'

test.describe('Agent turn snapshots', () => {
  let repo: string
  let sessionId: string
  /** The task whose checkout the turn list reads (its path scope, §9 Phase 7b). */
  let turnTaskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    repo = fs.realpathSync(createIsolatedGitRepo(`turns-${Date.now()}`))
    await mainWindow.evaluate(() =>
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_agent_startup', value: 'instant' })
    )
    await mainWindow.evaluate(
      (id) =>
        window.getTrpcVanillaClient().pty.agentsCreate.mutate({
          id,
          label: 'Turn Snapshots E2E',
          type: 'claude-code',
          initialCommand: null,
          resumeCommand: null,
          defaultFlags: '',
          enabled: true,
          order: 999
        }),
      MODE
    )
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Turn Snapshots', color: '#16a34a', path: repo })
    const t = await s.createTask({ projectId: p.id, title: 'Turn task', status: 'in_progress' })
    sessionId = getMainSessionId(t.id)
    turnTaskId = t.id
    await mainWindow.evaluate(
      ({ id, m }) => window.getTrpcVanillaClient().task.update.mutate({ id, agentId: m }),
      { id: t.id, m: MODE }
    )
    await s.refreshData()
    await openTaskTerminal(mainWindow, {
      projectAbbrev: p.name.slice(0, 2).toUpperCase(),
      taskTitle: 'Turn task'
    })
    await waitForPtySession(mainWindow, sessionId)
  })

  test.afterAll(async ({ mainWindow }) => {
    await mainWindow
      .evaluate((id) => window.getTrpcVanillaClient().pty.agentsDelete.mutate({ id }), MODE)
      .catch(() => {})
    await mainWindow
      .evaluate(() =>
        window
          .getTrpcVanillaClient()
          .settings.set.mutate({ key: 'terminal_agent_startup', value: 'manual' })
      )
      .catch(() => {})
  })

  test('a submitted prompt with changes in the worktree records a turn', async ({ mainWindow }) => {
    // Shell ready before typing (the line must reach a prompt, not a starting shell).
    await runCommand(mainWindow, sessionId, 'echo TURN_SHELL_READY')
    await waitForBufferContains(mainWindow, sessionId, 'TURN_SHELL_READY', 15_000)
    fs.writeFileSync(path.join(repo, 'agent-edit.txt'), 'changed by the agent')
    await runCommand(mainWindow, sessionId, 'echo second turn')

    await expect
      .poll(
        async () =>
          (
            (await mainWindow.evaluate(
              ({ taskId }) => window.getTrpcVanillaClient().agentTurns.list.query({ taskId }),
              { taskId: turnTaskId }
            )) as unknown[]
          ).length,
        { timeout: 20_000 }
      )
      .toBeGreaterThanOrEqual(1)
    const refs = execSync('git for-each-ref refs/slayzone', { cwd: repo }).toString()
    expect(refs.trim()).not.toBe('')
  })
})
