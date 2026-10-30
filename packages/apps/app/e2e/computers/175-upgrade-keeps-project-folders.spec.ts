/**
 * Upgrading from 0.36.2 keeps every project's folder, with nothing for the user to
 * do: each agent starts in the folder the project had, and the task page says what
 * it always said when there is none or it is gone.
 *
 * Boots the app on a hub database exactly as 0.36.2 left it (real migrations up to
 * v171, 0.36-shaped rows). The case that once lost 14 of 15 real projects: 0.36
 * already kept a `ready` copy of a folder that the computer does not list (its own
 * record is empty or keyed by an old hub address), and the hub dropped such
 * copies on connect.
 *
 * Uses a custom AI-labelled mode with no initial command, so the "agent" is a
 * plain shell the test can ask `pwd`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
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
  runCommand,
  waitForBufferContains,
  waitForPtySession
} from '../fixtures/terminal'
import { writeReleasedHubDb } from '../fixtures/released-hub-db'

/** The desktop app's own computer: a fixed id 0.36 enrolled it under too. */
const LOCAL_COMPUTER = 'f01a216a-4803-4214-98eb-f9e28951e1bb'
const modeId = 'upgrade-shell-e2e'

interface Seeded {
  id: string
  path: string | null
}

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

test('upgrade from 0.36.2: every project keeps its folder, agents start in it', async () => {
  test.setTimeout(240_000)
  // Outside the home folder: the computer only allows its home by default, and
  // 0.36 had no such limit, so the upgrade must widen it, not refuse the folder.
  const outsideHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'slz-upgrade-')))
  const projects: Record<string, Seeded> = {}
  const app = await launchIsolatedElectron({
    name: 'upgrade-keeps-project-folders',
    seedUserData: (dir) => {
      const folder = (name: string): string => {
        const p = path.join(dir, 'projects', name)
        mkdirSync(p, { recursive: true })
        return p
      }
      Object.assign(projects, {
        hadReadyCopy: { id: 'p-ready-copy', path: folder('had-ready-copy') },
        noCopy: { id: 'p-no-copy', path: folder('no-copy') },
        outside: { id: 'p-outside-home', path: outsideHome },
        gone: { id: 'p-gone', path: path.join(dir, 'projects', 'deleted-since') },
        none: { id: 'p-no-folder', path: null }
      } satisfies Record<string, Seeded>)
      const hubDir = path.join(dir, 'dev', 'hub')
      mkdirSync(hubDir, { recursive: true })
      writeReleasedHubDb(path.join(hubDir, 'slayzone.dev.data.sqlite'), 'v0.36.2', (db) => {
        db.prepare(
          `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at)
           VALUES (?, 'local-computer', ?, '0.36.2', '[]', 1)`
        ).run(LOCAL_COMPUTER, `${process.platform}-${process.arch}`)
        const project = db.prepare(
          `INSERT INTO projects (id, name, color, path, sort_order) VALUES (?, ?, '#0ea5e9', ?, ?)`
        )
        Object.entries(projects).forEach(([name, p], i) => project.run(p.id, name, p.path, i))
        // What 0.36 kept for a folder it had already given the local computer.
        db.prepare(
          `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
           VALUES (?, ?, ?, 'ready', 1)`
        ).run(LOCAL_COMPUTER, projects.hadReadyCopy.id, projects.hadReadyCopy.path)
      })
    }
  })
  try {
    const page = app.page
    expect(await waitForUsableComputer(page)).toBe(true)
    const s = seed(page)

    // Every folder is on the local computer, which every project now uses.
    const expected = {
      [projects.hadReadyCopy.id]: 'ready',
      [projects.noCopy.id]: 'ready',
      [projects.outside.id]: 'ready',
      [projects.gone.id]: 'missing'
    }
    await expect
      .poll(
        async () =>
          Object.fromEntries(
            (await s.getProjects())
              .filter((p) => p.id in expected)
              .map((p) => [
                p.id,
                p.placements.find((pl) => pl.computer_id === LOCAL_COMPUTER)?.status
              ])
          ),
        { timeout: 60_000 }
      )
      .toEqual(expected)
    for (const p of await s.getProjects()) {
      const seeded = Object.values(projects).find((x) => x.id === p.id)
      if (!seeded?.path) continue
      expect(p.resolved_computer_id, `${p.name} uses the local computer`).toBe(LOCAL_COMPUTER)
      expect(p.placements.find((pl) => pl.computer_id === LOCAL_COMPUTER)?.path).toBe(seeded.path)
    }

    await page.evaluate(
      (id) =>
        window.getTrpcVanillaClient().pty.modesCreate.mutate({
          id,
          label: 'Upgrade Shell E2E',
          type: 'claude-code',
          initialCommand: null,
          resumeCommand: null,
          defaultFlags: '',
          enabled: true,
          order: 999
        }),
      modeId
    )
    await page.evaluate(() =>
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_agent_startup', value: 'instant' })
    )
    const taskIn = async (p: Seeded, title: string): Promise<string> => {
      const task = await s.createTask({ projectId: p.id, title, status: 'in_progress' })
      await page.evaluate(
        ({ id, m }) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: m }),
        { id: task.id, m: modeId }
      )
      return task.id
    }

    for (const p of [projects.hadReadyCopy, projects.noCopy, projects.outside]) {
      const taskId = await taskIn(p, `agent in ${path.basename(p.path!)}`)
      await s.refreshData()
      await openTask(page, taskId)
      const sessionId = getMainSessionId(taskId)
      await waitForPtySession(page, sessionId)
      await runCommand(page, sessionId, 'pwd -P')
      await waitForBufferContains(page, sessionId, realpathSync(p.path!))
    }

    // No folder, and a folder that is gone: the words the desktop app always used.
    const noFolder = await taskIn(projects.none, 'no folder')
    const gone = await taskIn(projects.gone, 'folder gone')
    await s.refreshData()
    await openTask(page, noFolder)
    await expect(page.getByText('No repository path configured').last()).toBeVisible()
    await openTask(page, gone)
    await expect(page.getByText('Folder not found on this task’s machine').last()).toBeVisible()
  } finally {
    await app.close()
    rmSync(outsideHome, { recursive: true, force: true })
  }
})
