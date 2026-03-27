import { test as base, expect, type Page, type Locator } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from 'playwright'
import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const APP_DIR = path.resolve(__dirname, '..', '..')
const MAIN_JS = path.join(APP_DIR, 'out', 'main', 'index.js')
const RUNTIME_ROOT_DIR = path.join(APP_DIR, '.e2e-runtime')
const LAUNCH_ATTEMPTS = 3
const LAUNCH_BACKOFF_MS = [300, 1000]

// Runtime path set in worker fixture before tests execute.
export let TEST_PROJECT_PATH = path.join(RUNTIME_ROOT_DIR, 'default-test-project')

// Shared state across all tests in the worker
let sharedApp: ElectronApplication | undefined
let sharedPage: Page | undefined
let sharedWorkerArtifactsDir: string | undefined
let sessionStdoutStream: fs.WriteStream | null = null
let sessionStderrStream: fs.WriteStream | null = null

type ElectronFixtures = {
  electronApp: ElectronApplication
  mainWindow: Page
}

interface LaunchAttemptRecord {
  attempt: number
  startedAt: string
  endedAt?: string
  durationMs?: number
  userDataDir: string
  workerArtifactsDir: string
  mainJsPath: string
  executablePath: string
  success: boolean
  error?: string
  observedWindowUrls?: string[]
  rootReadyMs?: number
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

/**
 * Ensure `dirPath` has its OWN git repo, not inheriting from a parent repo.
 * TEST_PROJECT_PATH lives inside the slayzone repo, so `--is-inside-work-tree`
 * would misleadingly succeed against the parent. We check `--show-toplevel` instead.
 */
export function ensureGitRepo(dirPath: string): void {
  try {
    const toplevel = execSync('git rev-parse --show-toplevel', {
      cwd: dirPath, stdio: 'pipe',
    }).toString().trim()
    if (toplevel !== dirPath) throw new Error('not own repo')
  } catch {
    execSync('git init', { cwd: dirPath, stdio: 'pipe' })
    execSync('git config user.name "Test"', { cwd: dirPath, stdio: 'pipe' })
    execSync('git config user.email "test@test.com"', { cwd: dirPath, stdio: 'pipe' })
    fs.writeFileSync(path.join(dirPath, 'README.md'), '# test\n')
    execSync('git add -A', { cwd: dirPath, stdio: 'pipe' })
    execSync('git -c commit.gpgsign=false commit -m "Initial commit"', { cwd: dirPath, stdio: 'pipe' })
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function writeJson(filePath: string, payload: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8')
}

function startProcessLogCapture(
  app: ElectronApplication,
  stdoutPath: string,
  stderrPath: string
): () => void {
  const proc = app.process()
  if (!proc) return () => {}

  const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'a' })
  const stderrStream = fs.createWriteStream(stderrPath, { flags: 'a' })

  const onStdout = (chunk: Buffer | string) => {
    stdoutStream.write(chunk)
  }
  const onStderr = (chunk: Buffer | string) => {
    stderrStream.write(chunk)
  }

  proc.stdout?.on('data', onStdout)
  proc.stderr?.on('data', onStderr)

  return () => {
    proc.stdout?.off('data', onStdout)
    proc.stderr?.off('data', onStderr)
    stdoutStream.end()
    stderrStream.end()
  }
}

function attachSessionLogCapture(app: ElectronApplication, artifactsDir: string): void {
  const proc = app.process()
  if (!proc) return

  const stdoutPath = path.join(artifactsDir, 'session.stdout.log')
  const stderrPath = path.join(artifactsDir, 'session.stderr.log')

  sessionStdoutStream = fs.createWriteStream(stdoutPath, { flags: 'a' })
  sessionStderrStream = fs.createWriteStream(stderrPath, { flags: 'a' })

  proc.stdout?.on('data', (chunk: Buffer | string) => {
    sessionStdoutStream?.write(chunk)
  })
  proc.stderr?.on('data', (chunk: Buffer | string) => {
    sessionStderrStream?.write(chunk)
  })
}

function closeSessionLogCapture(): void {
  sessionStdoutStream?.end()
  sessionStderrStream?.end()
  sessionStdoutStream = null
  sessionStderrStream = null
}

/**
 * Reset the app to a clean state: kill all processes/PTYs, drop all tables,
 * re-migrate, reload the renderer. Call in `test.beforeAll` for test isolation.
 * Onboarding is pre-seeded as completed by the reset handler.
 */
export async function resetApp(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__testInvoke('app:reset-for-test'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#root', { timeout: 10_000 })
}

/**
 * In regular app runs there is a splash window (data: URL) before the main window.
 * In Playwright mode the splash is disabled, so we resolve the first non-data window either way.
 */
async function resolveMainWindow(
  app: ElectronApplication,
  timeoutMs = 20_000
): Promise<{ page: Page; observedWindowUrls: string[]; rootReadyMs: number }> {
  const startedAt = Date.now()
  const observedWindowUrls = new Set<string>()
  const isMain = (url: string) => !url.startsWith('data:') && url !== 'about:blank'

  while (Date.now() - startedAt < timeoutMs) {
    const windows = app.windows()
    for (const windowPage of windows) {
      const url = windowPage.url()
      observedWindowUrls.add(url)

      if (!isMain(url)) continue

      try {
        await windowPage.waitForSelector('#root', {
          timeout: Math.max(200, timeoutMs - (Date.now() - startedAt)),
        })
        return {
          page: windowPage,
          observedWindowUrls: Array.from(observedWindowUrls),
          rootReadyMs: Date.now() - startedAt,
        }
      } catch {
        // Keep polling until timeout so slow bootstrap can still recover.
      }
    }

    await wait(200)
  }

  throw new Error(
    `Main window not ready within ${timeoutMs}ms. Observed URLs: ${JSON.stringify(Array.from(observedWindowUrls))}`
  )
}

async function launchElectronWithRetry(args: {
  userDataDir: string
  workerArtifactsDir: string
  executablePath: string
}): Promise<{ app: ElectronApplication; page: Page; attempts: LaunchAttemptRecord[] }> {
  const attempts: LaunchAttemptRecord[] = []

  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
    const attemptStartedAt = Date.now()
    const attemptArtifactsDir = path.join(args.workerArtifactsDir, `launch-attempt-${attempt}`)
    ensureDir(attemptArtifactsDir)

    const record: LaunchAttemptRecord = {
      attempt,
      startedAt: new Date(attemptStartedAt).toISOString(),
      userDataDir: args.userDataDir,
      workerArtifactsDir: args.workerArtifactsDir,
      mainJsPath: MAIN_JS,
      executablePath: args.executablePath,
      success: false,
    }

    let app: ElectronApplication | undefined
    let stopAttemptLogCapture: (() => void) | undefined

    try {
      const launchEnv: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (value == null) continue
        launchEnv[key] = value
      }
      // Prevent host shell dev-server overrides from leaking into deterministic e2e launches.
      delete launchEnv.ELECTRON_RENDERER_URL

      app = await electron.launch({
        args: [MAIN_JS],
        executablePath: args.executablePath,
        env: { ...launchEnv, PLAYWRIGHT: '1', SLAYZONE_DB_DIR: args.userDataDir },
      })

      stopAttemptLogCapture = startProcessLogCapture(
        app,
        path.join(attemptArtifactsDir, 'stdout.log'),
        path.join(attemptArtifactsDir, 'stderr.log')
      )

      const resolved = await resolveMainWindow(app, 20_000)
      record.success = true
      record.observedWindowUrls = resolved.observedWindowUrls
      record.rootReadyMs = resolved.rootReadyMs
      record.endedAt = new Date().toISOString()
      record.durationMs = Date.now() - attemptStartedAt

      writeJson(path.join(attemptArtifactsDir, 'launch-meta.json'), record)
      attempts.push(record)
      stopAttemptLogCapture?.()

      return { app, page: resolved.page, attempts }
    } catch (error) {
      record.success = false
      record.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      record.endedAt = new Date().toISOString()
      record.durationMs = Date.now() - attemptStartedAt
      writeJson(path.join(attemptArtifactsDir, 'launch-meta.json'), record)
      attempts.push(record)

      stopAttemptLogCapture?.()

      if (app) {
        await app.close().catch(() => {})
      }

      if (attempt < LAUNCH_ATTEMPTS) {
        await wait(LAUNCH_BACKOFF_MS[attempt - 1] ?? 1000)
      }
    }
  }

  throw new Error(
    `Electron failed to launch after ${LAUNCH_ATTEMPTS} attempts. See artifacts in ${args.workerArtifactsDir}`
  )
}

export const test = base.extend<ElectronFixtures>({
  electronApp: [
    async ({}, use, workerInfo) => {
      if (!sharedApp) {
        const workerRoot = path.join(
          RUNTIME_ROOT_DIR,
          `worker-${workerInfo.workerIndex}-${process.pid}-${Date.now()}`
        )
        const userDataDir = path.join(workerRoot, 'userdata')
        const workerArtifactsDir = path.join(workerRoot, 'artifacts')

        TEST_PROJECT_PATH = path.join(workerRoot, 'test-project')
        ensureDir(userDataDir)
        ensureDir(TEST_PROJECT_PATH)
        ensureGitRepo(TEST_PROJECT_PATH)
        ensureDir(workerArtifactsDir)

        const executablePath = require('electron') as unknown as string

        const launched = await launchElectronWithRetry({
          userDataDir,
          workerArtifactsDir,
          executablePath,
        })

        sharedApp = launched.app
        sharedPage = launched.page
        sharedWorkerArtifactsDir = workerArtifactsDir

        writeJson(path.join(workerArtifactsDir, 'launch-attempts-summary.json'), {
          workerIndex: workerInfo.workerIndex,
          createdAt: new Date().toISOString(),
          userDataDir,
          testProjectPath: TEST_PROJECT_PATH,
          attempts: launched.attempts,
        })

        attachSessionLogCapture(sharedApp, workerArtifactsDir)
      }

      await use(sharedApp)

      if (sharedApp) {
        await sharedApp.close().catch(() => {})
      }

      closeSessionLogCapture()

      if (sharedWorkerArtifactsDir) {
        writeJson(path.join(sharedWorkerArtifactsDir, 'worker-finish.json'), {
          finishedAt: new Date().toISOString(),
          note: 'Worker teardown completed',
        })
      }

      sharedApp = undefined
      sharedPage = undefined
      sharedWorkerArtifactsDir = undefined
    },
    { scope: 'worker' },
  ],

  mainWindow: [
    async ({ electronApp }, use) => {
      if (!sharedPage) {
        const resolved = await resolveMainWindow(electronApp, 20_000)
        sharedPage = resolved.page
      }

      // Resize the actual BrowserWindow so the app fills the viewport
      await electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find(
          (w) =>
            !w.isDestroyed() &&
            w.webContents.getURL() !== 'about:blank' &&
            !w.webContents.getURL().startsWith('data:')
        )
        if (win) {
          win.setSize(1920, 1200)
          win.center()
        }
      })

      await use(sharedPage)
    },
    { scope: 'worker' },
  ],
})

/** Seed helpers — call window.api methods to create test data without UI interaction */
export function seed(page: Page) {
  return {
    createProject: (data: { name: string; color: string; path?: string }) =>
      page.evaluate((d) => window.api.db.createProject(d), data),

    createTask: (data: {
      projectId: string
      title: string
      status?: string
      priority?: number
      dueDate?: string
    }) => page.evaluate((d) => window.api.db.createTask(d), data),

    updateTask: (data: { id: string; status?: string; priority?: number; dueDate?: string | null }) =>
      page.evaluate((d) => window.api.db.updateTask(d), data),

    deleteTask: (id: string) => page.evaluate((i) => window.api.db.deleteTask(i), id),

    archiveTask: (id: string) => page.evaluate((i) => window.api.db.archiveTask(i), id),

    archiveTasks: (ids: string[]) => page.evaluate((i) => window.api.db.archiveTasks(i), ids),

    createTag: (data: { name: string; color?: string; projectId: string }) =>
      page.evaluate((d) => window.api.tags.createTag(d), data),

    updateTag: (data: { id: string; name?: string; color?: string }) =>
      page.evaluate((d) => window.api.tags.updateTag(d), data),

    deleteTag: (id: string) => page.evaluate((i) => window.api.tags.deleteTag(i), id),

    getTags: () => page.evaluate(() => window.api.tags.getTags()),

    setTagsForTask: (taskId: string, tagIds: string[]) =>
      page.evaluate(({ t, tags }) => window.api.taskTags.setTagsForTask(t, tags), {
        t: taskId,
        tags: tagIds,
      }),

    addBlocker: (taskId: string, blockerTaskId: string) =>
      page.evaluate(({ t, b }) => window.api.taskDependencies.addBlocker(t, b), {
        t: taskId,
        b: blockerTaskId,
      }),

    getProjects: () => page.evaluate(() => window.api.db.getProjects()),

    getTasks: () => page.evaluate(() => window.api.db.getTasks()),

    updateProject: (data: {
      id: string
      name?: string
      color?: string
      path?: string | null
      autoCreateWorktreeOnTaskCreate?: boolean | null
      columnsConfig?: Array<{
        id: string
        label: string
        color: string
        position: number
        category: 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'
      }> | null
    }) =>
      page.evaluate((d) => window.api.db.updateProject(d), data),

    deleteProject: (id: string) => page.evaluate((i) => window.api.db.deleteProject(i), id),

    deleteAllProjects: async () => {
      await page.evaluate(async () => {
        const projects = await window.api.db.getProjects()
        for (const p of projects) await window.api.db.deleteProject(p.id)
      })
    },

    setSetting: (key: string, value: string) =>
      page.evaluate(({ k, v }) => window.api.settings.set(k, v), { k: key, v: value }),

    getSetting: (key: string) => page.evaluate((k) => window.api.settings.get(k), key),

    setTheme: (theme: 'light' | 'dark' | 'system') =>
      page.evaluate((t) => window.api.theme.set(t), theme),

    /** Re-fetch all data from DB into React state */
    refreshData: () =>
      page.evaluate(async () => {
        await (window as any).__slayzone_refreshData?.()
        await new Promise((resolve) => setTimeout(resolve, 50))
      }),
  }
}

/** Scope selectors to the sidebar */
const sidebar = (page: Page) => page.locator('[data-slot="sidebar"]').first()

/** Click a project blob in the sidebar by its 2-letter abbreviation */
export async function clickProject(page: Page, abbrev: string) {
  const target = sidebar(page).getByRole('button', { name: abbrev, exact: true }).last()
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if ((await target.count()) > 0) {
      await target.scrollIntoViewIfNeeded().catch(() => {})
      const clicked = await target.click({ timeout: 1_000 }).then(() => true).catch(async () => {
        return await target.click({ force: true, timeout: 1_000 }).then(() => true).catch(() => false)
      })
      if (clicked) return
    }
    await page.evaluate(async () => {
      const refresh = (window as { __slayzone_refreshData?: () => Promise<void> | void }).__slayzone_refreshData
      await refresh?.()
    })
    await page.waitForTimeout(100)
  }
  // Fallback: open command palette and select by query when sidebar badges are unavailable.
  await page.keyboard.press('Meta+k')
  const input = page.getByPlaceholder('Search tasks and projects...')
  await input.fill(abbrev)
  await page.keyboard.press('Enter')
  await input.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
}

/** Click the + button in the sidebar to add a project */
export async function clickAddProject(page: Page) {
  await sidebar(page).locator('button[title="Add project"]').click()
}

/** Click the settings button in the sidebar footer */
export async function clickSettings(page: Page) {
  const dialog = page.locator('[role="dialog"][aria-label="Settings"]').first()
  if (await dialog.isVisible({ timeout: 200 }).catch(() => false)) return

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.bringToFront().catch(() => {})

    await page.keyboard.press('Meta+,').catch(() => {})
    if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) return

    const sidebarSettingsButton = page.getByRole('button', { name: 'Settings', exact: true }).first()
    if (await sidebarSettingsButton.isVisible({ timeout: 300 }).catch(() => false)) {
      await sidebarSettingsButton.click({ force: true }).catch(() => {})
      if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) return
    }

    const footer = sidebar(page).locator('[data-sidebar="footer"]').first()
    const footerIconButton = footer
      .locator('button')
      .filter({ has: page.locator('.lucide-settings') })
      .first()
    if (await footerIconButton.isVisible({ timeout: 300 }).catch(() => false)) {
      await footerIconButton.click({ force: true }).catch(() => {})
      if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) return
    }
  }
}

/** Navigate to home tab (div with lucide house/home icon, no title attr) */
export async function goHome(page: Page) {
  const icon = page.locator('.lucide-house, .lucide-home').first()
  if (await icon.isVisible({ timeout: 500 }).catch(() => false)) {
    await icon.click({ timeout: 2_000 }).catch(async () => {
      await icon.click({ force: true, timeout: 2_000 }).catch(() => {})
    })
  }
}

/** Check if a project blob exists in the sidebar */
export function projectBlob(page: Page, abbrev: string) {
  return sidebar(page).getByRole('button', { name: abbrev, exact: true }).last()
}

/** Open Project Settings for a given sidebar project abbreviation. */
export async function openProjectSettings(page: Page, abbrev: string): Promise<Locator> {
  const dialog = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: 'Project Settings' }) })
    .last()

  // Fast path: dialog is already open from a prior action in the same test flow.
  if (await dialog.isVisible({ timeout: 400 }).catch(() => false)) {
    return dialog
  }

  // Clean up any stray modal/dialog left by prior specs.
  const openDialogs = page.locator('[role="dialog"][data-state="open"], [role="dialog"][aria-modal="true"]')
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await openDialogs.count()) === 0) break
    const top = openDialogs.last()
    const closeButton = top.getByRole('button', { name: /close|cancel|done|skip/i }).first()
    if (await closeButton.isVisible({ timeout: 200 }).catch(() => false)) {
      await closeButton.click({ force: true }).catch(() => {})
    } else {
      await top.press('Escape').catch(() => {})
      await page.keyboard.press('Escape').catch(() => {})
    }
    await page.waitForTimeout(100)
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await dialog.isVisible({ timeout: 300 }).catch(() => false)) break

    await goHome(page)
    await clickProject(page, abbrev)
    const blob = projectBlob(page, abbrev)
    await expect(blob).toBeVisible({ timeout: 5_000 })
    await blob.scrollIntoViewIfNeeded().catch(() => {})

    // Right-click → Settings via evaluate (fast, avoids Playwright actionability overhead)
    await blob.evaluate((node) => {
      node.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2, buttons: 2,
      }))
    }).catch(() => {})

    const settingsItem = page.getByRole('menuitem', { name: 'Settings' }).first()
    if (await settingsItem.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await settingsItem.click({ force: true }).catch(() => {})
    }

    if (await dialog.isVisible({ timeout: 1_500 }).catch(() => false)) break
    await page.waitForTimeout(150)
  }

  await expect(dialog).toBeVisible({ timeout: 5_000 })
  return dialog
}

export { expect }
