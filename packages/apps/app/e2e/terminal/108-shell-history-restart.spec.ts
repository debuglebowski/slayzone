/**
 * A shell tab's output survives an app restart: after quitting and relaunching,
 * the same tab shows its old output, a divider, then a working new shell.
 *
 * Regression (QA 2026-11-06, task 964073b0 row 7a → task 5decc957): the tab came
 * back with a fresh prompt — the marker and all 250 seeded lines gone from the UI
 * and from `pty buffer`. The local computer stops with the app, so this is a
 * computer restart too. The computer now saves each task terminal's output under
 * its own state dir (pty-history.ts) and restores it into the next start.
 */
import { mkdirSync, realpathSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { Page } from '@playwright/test'
import {
  test,
  expect,
  seed,
  launchIsolatedElectron,
  waitForUsableComputer
} from '../fixtures/electron'
import {
  getMainSessionId,
  readFullBuffer,
  runCommand,
  waitForBufferContains,
  waitForPtySession
} from '../fixtures/terminal'

const MARKER = 'QA_RESTART_HISTORY_964073B0'
const DIVIDER = 'Restored output · the terminal restarted below'

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

/** A free loopback port, so both launches are the same hub (as the fixed port is). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

test('a shell tab keeps its output across an app restart', async () => {
  test.setTimeout(240_000)
  const hubPort = String(await freePort())
  const extraEnv = () => ({ SLAYZONE_E2E_HUB_PORT: hubPort })
  let repo = ''
  const first = await launchIsolatedElectron({
    name: 'shell-history-restart',
    extraEnv,
    seedUserData: (dir) => {
      repo = path.join(dir, 'projects', 'history')
      mkdirSync(repo, { recursive: true })
    }
  })
  let taskId = ''
  try {
    expect(await waitForUsableComputer(first.page)).toBe(true)
    const s = seed(first.page)
    const p = await s.createProject({ name: 'History', color: '#0ea5e9', path: realpathSync(repo) })
    const t = await s.createTask({ projectId: p.id, title: 'Shell history', status: 'in_progress' })
    taskId = t.id
    await first.page.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, agentId: 'terminal' }),
      taskId
    )
    await s.refreshData()
    await openTask(first.page, taskId)
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(first.page, sessionId)
    await runCommand(first.page, sessionId, `echo ${MARKER}; seq 1 250`)
    // The OUTPUT's last line, not '250': the echoed command line `seq 1 250` holds
    // that already, so the app could quit before the shell had printed anything.
    await waitForBufferContains(first.page, sessionId, '\r\n250\r\n', 15_000)
  } finally {
    await first.close()
  }

  const second = await launchIsolatedElectron({
    name: 'shell-history-restart',
    extraEnv,
    userDataDir: first.userDataDir
  })
  try {
    expect(await waitForUsableComputer(second.page)).toBe(true)
    await openTask(second.page, taskId)
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(second.page, sessionId)
    await waitForBufferContains(second.page, sessionId, DIVIDER, 20_000)
    await runCommand(second.page, sessionId, 'echo QA_AFTER_RESTART_INPUT_OK')
    await waitForBufferContains(second.page, sessionId, 'QA_AFTER_RESTART_INPUT_OK', 15_000)
    const text = await readFullBuffer(second.page, sessionId)
    expect(text.indexOf(`${MARKER}\r\n1\r\n`)).toBeGreaterThanOrEqual(0)
    expect(text).toContain('\r\n250\r\n')
    expect(text.indexOf(DIVIDER)).toBeGreaterThan(text.indexOf('\r\n250\r\n'))
    expect(text.lastIndexOf('QA_AFTER_RESTART_INPUT_OK')).toBeGreaterThan(text.indexOf(DIVIDER))
  } finally {
    await second.close()
  }
})
