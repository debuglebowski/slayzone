import { test as base, type Page } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from 'playwright'
import path from 'path'
import fs from 'fs'
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

      // Dismiss onboarding if it appears
      const skip = sharedPage.getByRole('button', { name: 'Skip' })
      if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await skip.click({ timeout: 2_000 }).catch(async () => {
          await skip.first().click({ force: true, timeout: 2_000 }).catch(() => {})
        })
      }

      await use(sharedPage)
    },
    { scope: 'worker' },
  ],
})

/** Seed helpers — call window.api methods to create test data without UI interaction */
export function seed(page: Page) {
  return {
    createProject: (data: { name: string; color: string; path?: string; taskBackend?: 'db' }) =>
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

    createTag: (data: { name: string; color?: string }) =>
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
      taskBackend?: 'db'
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
      await target.click()
      return
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
  // Settings button is in sidebar footer, has tooltip "Settings" but no title attr
  const button = sidebar(page).locator('[data-sidebar="footer"] button').last()
  try {
    await button.click()
  } catch {
    await page.keyboard.press('Meta+,')
  }
}

/** Navigate to home tab (div with lucide house/home icon, no title attr) */
export async function goHome(page: Page) {
  for (const sel of ['.lucide-house', '.lucide-home']) {
    const icon = page.locator(sel).first()
    if (await icon.isVisible({ timeout: 500 }).catch(() => false)) {
      await icon.click({ timeout: 2_000 }).catch(async () => {
        await icon.click({ force: true, timeout: 2_000 }).catch(() => {})
      })
      return
    }
  }
}

/** Check if a project blob exists in the sidebar */
export function projectBlob(page: Page, abbrev: string) {
  return sidebar(page).getByText(abbrev, { exact: true })
}

export { expect } from '@playwright/test'
