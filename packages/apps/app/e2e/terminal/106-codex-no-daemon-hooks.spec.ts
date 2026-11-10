/**
 * Codex hooks reach SlayZone: the codex terminal starts `codex --no-daemon` when
 * the computer's Codex has the flag, so its hooks run with the terminal's env.
 *
 * Regression (QA 2026-11-06, task 964073b0 rows 1e/1f → task 5decc957): Codex
 * ≥0.157 runs turns in a SHARED background daemon started by whoever launched
 * codex first, and runs hooks there with THAT process's env. The task's
 * SLAYZONE_AGENT_HOOK_URL / _CONTEXT never reached notify.sh, so nothing arrived:
 * spinner stuck on Idle, no unread dot, the task's codex session id
 * null ("Session not saved yet"), no resume, no turn snapshots, task cost 0.
 *
 * The fake `codex` (bin override dir, so the computer resolves it for both the
 * version probe and the launch) reports 0.167.0 and behaves like the real one:
 * its SessionStart hook runs with the terminal's env only under `--no-daemon`;
 * otherwise in a foreign env (the daemon's), where notify.sh has no URL and
 * exits silently. The assertion is the user-visible symptom: the session id is
 * captured on the task.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  test as base,
  expect,
  newRuntimeDir,
  notifyScriptPath,
  resetApp,
  seed,
  TEST_PROJECT_PATH
} from '../fixtures/electron'
import { currentSession, openTaskTerminal, waitForBufferContains } from '../fixtures/terminal'

const SESSION_ID = '01a1b277-b4d0-7052-a200-eb63b10c21d2'

const binDir = newRuntimeDir('fake-codex-pty')
fs.mkdirSync(binDir, { recursive: true })
const argvLog = path.join(binDir, 'argv.log')
/** Written once the app tells us where its notify.sh lives (see beforeAll). */
const notifyPathFile = path.join(binDir, 'notify-path')

fs.writeFileSync(
  path.join(binDir, 'codex'),
  `#!/bin/bash
if [ "$1" = "--version" ]; then echo "codex-cli 0.167.0"; exit 0; fi
printf '%s\\n' "$*" >> '${argvLog}'
NOTIFY="$(cat '${notifyPathFile}')"
PAYLOAD='{"hook_event_name":"SessionStart","session_id":"${SESSION_ID}","source":"startup"}'
case " $* " in
  *" --no-daemon "*) printf '%s' "$PAYLOAD" | bash "$NOTIFY" >/dev/null 2>&1 ;;
  # The shared daemon runs the hook: its env, not this terminal's.
  *) printf '%s' "$PAYLOAD" | env -i PATH="$PATH" HOME="$HOME" bash "$NOTIFY" >/dev/null 2>&1 ;;
esac
echo "FAKE_CODEX_READY"
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

/** A Codex-type agent that runs the fake by absolute path: a login shell puts its own
 *  PATH (with any real `codex`) ahead of the bin override dir, so a bare `codex`
 *  would launch the developer's real CLI. The version probe still asks for `codex`
 *  on the computer's spawn PATH, where the override dir wins — the same fake. */
const MODE = 'codex-no-daemon-e2e'

test.describe('Codex hooks with a daemon-era Codex', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const env = (await mainWindow.evaluate(() =>
      window.__testInvoke('e2e:get-env', ['SLAYZONE_USER_DATA_DIR'])
    )) as Record<string, string>
    fs.writeFileSync(notifyPathFile, notifyScriptPath(env.SLAYZONE_USER_DATA_DIR))

    // AI-mode terminals are idle-gated; this custom mode's starter label matches no
    // built-in, so spawn on open (the gate is 93/97's subject).
    await mainWindow.evaluate(() =>
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_agent_startup', value: 'instant' })
    )
    await mainWindow.evaluate(
      ({ id, command }) =>
        window.getTrpcVanillaClient().pty.agentsCreate.mutate({
          id,
          label: 'Codex No Daemon E2E',
          type: 'codex',
          initialCommand: `${command} {flags}`,
          resumeCommand: `${command} {flags} resume {id}`,
          defaultFlags: '--sandbox workspace-write',
          enabled: true,
          order: 999
        }),
      { id: MODE, command: path.join(binDir, 'codex') }
    )

    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Codex No Daemon',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    const t = await s.createTask({ projectId: p.id, title: 'Codex daemon task', status: 'todo' })
    taskId = t.id
    await mainWindow.evaluate(
      ({ id, mode }) => window.getTrpcVanillaClient().task.update.mutate({ id, agentId: mode }),
      { id: taskId, mode: MODE }
    )
    await s.refreshData()
    await openTaskTerminal(mainWindow, {
      projectAbbrev: p.name.slice(0, 2).toUpperCase(),
      taskTitle: 'Codex daemon task'
    })
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

  test('the session id is captured on the task', async ({ mainWindow }) => {
    await waitForBufferContains(mainWindow, `${taskId}:${taskId}`, 'FAKE_CODEX_READY', 20_000)
    await expect
      .poll(
        async () => {
          return currentSession(mainWindow, taskId, MODE)
        },
        { timeout: 15_000 }
      )
      .toBe(SESSION_ID)
    expect(fs.readFileSync(argvLog, 'utf8')).toContain('--no-daemon')
  })
})
