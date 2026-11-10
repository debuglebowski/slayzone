/**
 * Terminal agent sessions are scoped per TAB (robustness plan §2, migration v201).
 *
 * Regression (2026-11-09, task ad79481c): a task with a main agent tab and a
 * second agent tab "deploy" of the same agent. Switching the MAIN agent's mode
 * reset the agent's session for the WHOLE task, so the deploy tab's next start
 * minted a fresh session and its real one was lost. (Before that, a second agent
 * tab resolved the main tab's session, so two tabs drove one conversation.)
 *
 * The fake `claude` (absolute path in a custom claude-code-type agent, so a login
 * shell's PATH cannot swap in the real CLI) logs its argv. The deploy tab must
 * start on ITS session — never the main tab's, never a fresh one — after the
 * main agent's mode switch.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  test as base,
  expect,
  newRuntimeDir,
  resetApp,
  seed,
  TEST_PROJECT_PATH
} from '../fixtures/electron'
import { openTaskTerminal, currentSession } from '../fixtures/terminal'

const binDir = newRuntimeDir('fake-claude-tabs')
fs.mkdirSync(binDir, { recursive: true })
const argvLog = path.join(binDir, 'argv.log')
fs.writeFileSync(
  path.join(binDir, 'claude'),
  `#!/bin/bash
printf '%s\\n' "$*" >> '${argvLog}'
echo "FAKE_CLAUDE_READY"
exec cat >/dev/null
`,
  { mode: 0o755 }
)

const test = base.extend<object>({
  appExtraEnv: [
    async ({}, use) => {
      await use({ SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR: binDir })
    },
    { scope: 'worker' }
  ]
})

const MODE = 'claude-tabs-e2e'
const MAIN_CONV = 'aaaaaaaa-1111-4111-8111-000000000001'
const DEPLOY_CONV = 'bbbbbbbb-2222-4222-8222-000000000002'

test.describe('Per-tab terminal agent sessions', () => {
  let taskId: string
  const deployTab = 'e2e-deploy-tab'

  test.beforeAll(async ({ mainWindow, electronApp }) => {
    await resetApp(mainWindow)
    const fake = path.join(binDir, 'claude')
    await mainWindow.evaluate(
      ({ id, command }) =>
        window.getTrpcVanillaClient().pty.agentsCreate.mutate({
          id,
          label: 'Claude Tabs E2E',
          type: 'claude-code',
          initialCommand: `${command} --session-id {id} {flags}`,
          resumeCommand: `${command} --resume {id} {flags}`,
          defaultFlags: '',
          enabled: true,
          order: 998
        }),
      { id: MODE, command: fake }
    )
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Tab Sessions',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    const t = await s.createTask({ projectId: p.id, title: 'Tab sessions task', status: 'todo' })
    taskId = t.id
    await mainWindow.evaluate(
      ({ id, mode }) => window.getTrpcVanillaClient().task.update.mutate({ id, agentId: mode }),
      { id: taskId, mode: MODE }
    )
    // The main tab + a second agent tab of the same mode, each with its own
    // resumable session (as v201 / the spawn path record them).
    await electronApp.evaluate(
      async ({}, a) => {
        const db = (globalThis as Record<string, unknown>).__db as {
          run: (sql: string, params?: unknown[]) => Promise<unknown>
        }
        await db.run(
          `INSERT OR IGNORE INTO terminal_tabs (id, task_id, label, mode, is_main, position, group_id, created_at)
           VALUES (?, ?, NULL, ?, 1, 0, ?, datetime('now'))`,
          [a.taskId, a.taskId, a.mode, a.taskId]
        )
        await db.run(
          `INSERT INTO terminal_tabs (id, task_id, label, mode, is_main, position, group_id, created_at)
           VALUES (?, ?, 'deploy', ?, 0, 1, ?, datetime('now'))`,
          [a.deployTab, a.taskId, a.mode, a.deployTab]
        )
      },
      { taskId, deployTab, mode: MODE }
    )
    // Each tab's resumable session, on the session ledger of the task's computer
    // (robustness plan §9: the hub keeps none).
    for (const [tab, conv] of [
      [taskId, MAIN_CONV],
      [deployTab, DEPLOY_CONV]
    ])
      await mainWindow.evaluate(
        ({ taskId, mode, tab, conv }) =>
          window.getTrpcVanillaClient().agentSessions.testLedger.mutate({
            taskId,
            op: 'recordConversation',
            args: {
              taskId,
              mode,
              tabId: tab,
              conversationId: conv,
              origin: 'slay-spawned-resume',
              createdAt: Date.now() - 60_000
            }
          }),
        { taskId, mode: MODE, tab, conv }
      )
    // The incident's trigger: the MAIN agent switches mode (and back).
    for (const mode of ['codex', MODE])
      await mainWindow.evaluate(
        ({ id, m }) =>
          window.getTrpcVanillaClient().task.switchMode.mutate({ taskId: id, mode: m }),
        { id: taskId, m: mode }
      )
    await s.refreshData()
  })

  test.afterAll(async ({ mainWindow }) => {
    await mainWindow
      .evaluate((id) => window.getTrpcVanillaClient().pty.agentsDelete.mutate({ id }), MODE)
      .catch(() => {})
  })

  test('the deploy tab starts on its own session after the main agent’s mode switch', async ({
    mainWindow
  }) => {
    // The main tab was reset by the switch; the deploy tab was not.
    expect(await currentSession(mainWindow, taskId, MODE)).toBeNull()
    expect(await currentSession(mainWindow, taskId, MODE, deployTab)).toBe(DEPLOY_CONV)

    await openTaskTerminal(mainWindow, { projectAbbrev: 'TA', taskTitle: 'Tab sessions task' })
    // A secondary tab spawns on open (only the main tab is idle-gated).
    await mainWindow.locator(`[data-testid="terminal-tab-${deployTab}"]:visible`).click()
    await expect
      .poll(() => (fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8') : ''), {
        timeout: 20_000
      })
      .toContain(DEPLOY_CONV)
    const argv = fs.readFileSync(argvLog, 'utf8')
    expect(argv).toContain(`--resume ${DEPLOY_CONV}`)
    expect(argv).not.toContain(MAIN_CONV)
  })
})
