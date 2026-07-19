import { test as base, expect, type Page, type Locator } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from 'playwright'
import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { pressShortcut } from './shortcuts'
import type { TrpcVanillaClient } from '@slayzone/transport/client'

declare global {
  interface Window {
    /** Exposed by main.tsx under Playwright — the vanilla tRPC client.
     *  Typing it here makes the page.evaluate() closures below type-checked. */
    getTrpcVanillaClient: () => TrpcVanillaClient
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const APP_DIR = path.resolve(__dirname, '..', '..')
const MAIN_JS = path.join(APP_DIR, 'out', 'main', 'index.js')
const RUNTIME_ROOT_DIR = path.join(APP_DIR, '.e2e-runtime')
const LAUNCH_ATTEMPTS = 3
const LAUNCH_BACKOFF_MS = [300, 1000]

// Runtime path set in worker fixture before tests execute.
export let TEST_PROJECT_PATH = path.join(RUNTIME_ROOT_DIR, 'default-test-project')

// Worker root set during fixture init — used by createIsolatedGitRepo.
let workerRootDir: string | undefined

/**
 * Create an isolated git repo for specs that run git commands during tests.
 * Prevents index.lock races between test git commands and the app's
 * background git IPC handlers operating on TEST_PROJECT_PATH.
 */
export function createIsolatedGitRepo(name: string): string {
  const base = workerRootDir ?? RUNTIME_ROOT_DIR
  const dir = path.join(base, `git-${name}`)
  fs.mkdirSync(dir, { recursive: true })
  ensureGitRepo(dir)
  return dir
}

// Shared state across all tests in the worker
let sharedApp: ElectronApplication | undefined
let sharedPage: Page | undefined
let sharedWorkerArtifactsDir: string | undefined

export function getWorkerArtifactsDir(): string | undefined {
  return sharedWorkerArtifactsDir
}
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
  let isOwnRepo = false
  try {
    const toplevel = execSync('git rev-parse --show-toplevel', {
      cwd: dirPath,
      stdio: 'pipe'
    })
      .toString()
      .trim()
    isOwnRepo = toplevel === dirPath
  } catch {
    isOwnRepo = false
  }

  if (!isOwnRepo) {
    execSync('git init', { cwd: dirPath, stdio: 'pipe' })
  }

  // ALWAYS assert local config (new OR reused repo) so commits never invoke a
  // GPG/1Password signer. Under load 1Password's signing agent intermittently
  // fails with "1Password: failed to fill whole buffer" → "fatal: failed to write
  // commit object", which fails a setup commit and cascades an entire describe.serial
  // block (one beforeAll throw → many "did not run"). Setting the flags in the test
  // repo's own config covers EVERY call site — including helpers (32/33) that don't
  // pass `-c commit.gpgsign=false` per-command — and survives repo reuse across runs.
  execSync('git config commit.gpgsign false', { cwd: dirPath, stdio: 'pipe' })
  execSync('git config tag.gpgsign false', { cwd: dirPath, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dirPath, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dirPath, stdio: 'pipe' })

  if (!isOwnRepo) {
    fs.writeFileSync(path.join(dirPath, 'README.md'), '# test\n')
    execSync('git add -A', { cwd: dirPath, stdio: 'pipe' })
    execSync('git -c commit.gpgsign=false commit -m "Initial commit"', {
      cwd: dirPath,
      stdio: 'pipe'
    })
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
 *
 * IMPORTANT: Every .spec.ts file MUST call resetApp(mainWindow) inside
 * test.beforeAll to ensure parallel worker isolation.
 */
export async function resetApp(page: Page): Promise<void> {
  // `app:reset-for-test` does bulk DB writes; under full-suite load the better-sqlite3
  // worker can briefly hold a write lock and the invoke rejects with "database is
  // locked". The reset is idempotent (it clears state), so retry until it lands — this
  // beforeAll-shared helper otherwise sheds an entire describe to one transient lock.
  await expect(async () => {
    await page.evaluate(() => (window as any).__testInvoke('app:reset-for-test'))
  }).toPass({ timeout: 15_000 })
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
          timeout: Math.max(200, timeoutMs - (Date.now() - startedAt))
        })
        return {
          page: windowPage,
          observedWindowUrls: Array.from(observedWindowUrls),
          rootReadyMs: Date.now() - startedAt
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
  /** Extra env merged LAST into the launch literal — lets an isolated spec pass
   *  otherwise-stripped SLAYZONE_* vars (e.g. 
   *  SLAYZONE_E2E_ALLOW_RUNNER / SLAYZONE_HUB_URL / SLAYZONE_RUNNER_JOIN_TOKEN) through
   *  the strip below. Wins over the fixed keys, so a spec may also override an
   *  isolation default intentionally. */
  extraEnv?: Record<string, string>
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
      success: false
    }

    let app: ElectronApplication | undefined
    let stopAttemptLogCapture: (() => void) | undefined

    try {
      // Sanitize the inherited env. When e2e runs from inside a *dogfooding*
      // SlayZone terminal (the dev app spawns the PTY), the parent leaks a pile
      // of runtime vars that silently override the per-worker isolation this
      // fixture sets up below — and corrupt the whole suite:
      //   • ELECTRON_RUN_AS_NODE=1 → the Electron binary boots as plain Node, so
      //     it rejects Playwright's --remote-debugging-port=0 ("bad option") and
      //     every spec fails at (0ms) with "Process failed to launch!".
      //   • ELECTRON_RENDERER_URL → points the renderer at the host dev-server.
      //   • SLAYZONE_STORE_DIR / SLAYZONE_DB_PATH → getTrpcDataRoot() resolves to
      //     the REAL dev data root instead of the worker dir, so specs read/write
      //     the real boot-config.json + data dir (e.g. 100-server-settings-toggle
      //     flips the real app to remote mode → 102-sidecar-crash-recovery + the
      //     rest boot sidecar-less and cascade-fail).
      //   • SLAYZONE_SUPERVISED / SLAYZONE_PORT / SLAYZONE_HOST* / SLAYZONE_MCP_PORT
      //     / SLAYZONE_TASK_ID … → dogfood host/task wiring the app must not see.
      // Strip every ELECTRON_*/SLAYZONE_* from the inherited copy; the explicit
      // `env:` literal below re-adds exactly the ones e2e needs.
      const launchEnv: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (value == null) continue
        if (/^(ELECTRON_|SLAYZONE_)/.test(key)) continue
        launchEnv[key] = value
      }

      const bootLogPath = path.join(attemptArtifactsDir, 'boot.log')
      ensureDir(attemptArtifactsDir)

      app = await electron.launch({
        args: [MAIN_JS],
        executablePath: args.executablePath,
        env: {
          ...launchEnv,
          PLAYWRIGHT: '1',
          SLAYZONE_STORE_DIR: args.userDataDir,
          SLAYZONE_USER_DATA_DIR: args.userDataDir,
          // Always-on boot tracing in e2e — cheap (~30 console.log per launch)
          // and lets profiling specs read the timeline from boot.log. We use
          // a file sink (not stdout) because Playwright's stdio capture races
          // with main-process output emitted before its 'data' listener attaches.
          SLAYZONE_DEBUG_BOOT: launchEnv.SLAYZONE_DEBUG_BOOT ?? '1',
          SLAYZONE_BOOT_LOG_PATH: bootLogPath,
          // Sandbox agent hook install paths so e2e never touches the dev user's
          // real ~/.slayzone or ~/.claude/settings.json. `SLAYZONE_E2E_INSTALL_HOOKS=1`
          // opts the install path back in despite PLAYWRIGHT=1 skipping it by default.
          SLAYZONE_E2E_INSTALL_HOOKS: '1',
          SLAYZONE_HOME_DIR: path.join(args.userDataDir, '.slayzone-home'),
          SLAYZONE_CLAUDE_SETTINGS_PATH: path.join(args.userDataDir, '.claude', 'settings.json'),
          SLAYZONE_GEMINI_SETTINGS_PATH: path.join(args.userDataDir, '.gemini', 'settings.json'),
          SLAYZONE_CODEX_HOOKS_PATH: path.join(args.userDataDir, '.codex', 'hooks.json'),
          SLAYZONE_ANTIGRAVITY_HOOKS_PATH: path.join(
            args.userDataDir,
            '.gemini',
            'config',
            'hooks.json'
          ),
          SLAYZONE_OPENCODE_PLUGIN_PATH: path.join(
            args.userDataDir,
            '.config',
            'opencode',
            'plugin',
            'slayzone-notify.js'
          ),
          XDG_CONFIG_HOME: path.join(args.userDataDir, '.config'),
          // Explicit passthrough for otherwise-stripped SLAYZONE_* vars an
          // isolated spec needs (runner-loopback:
          // SLAYZONE_E2E_ALLOW_RUNNER, SLAYZONE_STORE_DIR, SLAYZONE_HUB_URL,
          // SLAYZONE_RUNNER_JOIN_TOKEN). Merged LAST so a spec can also override an
          // isolation default on purpose. Undefined for every default launch
          // (shared worker app + 103) → byte-identical there.
          ...(args.extraEnv ?? {})
        }
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

/**
 * Launch a SECOND, fully isolated Electron instance with its own fresh
 * userdata dir — for specs that must control boot-time state (e.g. seeding
 * boot-config.json before launch) and can't use the shared worker app.
 * Caller owns the lifecycle: always `await close()` in a finally block.
 */
export async function launchIsolatedElectron(opts: {
  /** Unique name for the runtime dir, e.g. the spec slug. */
  name: string
  /** Runs after the userdata dir exists, before Electron launches. */
  seedUserData?: (userDataDir: string) => void
  /** Extra env for the launch (merged last, past the env strip for
   *  `SLAYZONE_`/`ELECTRON_` prefixes). Receives the resolved `userDataDir` so a
   *  spec can pin store/hub paths into it (e.g. the runner-loopback spec sets
   *  SLAYZONE_STORE_DIR + opt-in flags). */
  extraEnv?: (userDataDir: string) => Record<string, string>
}): Promise<{
  app: ElectronApplication
  page: Page
  userDataDir: string
  close: () => Promise<void>
}> {
  const root = path.join(RUNTIME_ROOT_DIR, `isolated-${opts.name}-${process.pid}-${Date.now()}`)
  const userDataDir = path.join(root, 'userdata')
  const artifactsDir = path.join(root, 'artifacts')
  ensureDir(userDataDir)
  ensureDir(artifactsDir)
  opts.seedUserData?.(userDataDir)

  const executablePath = require('electron') as unknown as string
  const launched = await launchElectronWithRetry({
    userDataDir,
    workerArtifactsDir: artifactsDir,
    executablePath,
    ...(opts.extraEnv ? { extraEnv: opts.extraEnv(userDataDir) } : {})
  })
  return {
    app: launched.app,
    page: launched.page,
    userDataDir,
    close: async () => {
      await launched.app.close().catch(() => {})
    }
  }
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

        workerRootDir = workerRoot
        TEST_PROJECT_PATH = path.join(workerRoot, 'test-project')
        ensureDir(userDataDir)
        ensureDir(TEST_PROJECT_PATH)
        ensureGitRepo(TEST_PROJECT_PATH)
        ensureDir(workerArtifactsDir)

        const executablePath = require('electron') as unknown as string

        const launched = await launchElectronWithRetry({
          userDataDir,
          workerArtifactsDir,
          executablePath
        })

        sharedApp = launched.app
        sharedPage = launched.page
        sharedWorkerArtifactsDir = workerArtifactsDir

        writeJson(path.join(workerArtifactsDir, 'launch-attempts-summary.json'), {
          workerIndex: workerInfo.workerIndex,
          createdAt: new Date().toISOString(),
          userDataDir,
          testProjectPath: TEST_PROJECT_PATH,
          attempts: launched.attempts
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
          note: 'Worker teardown completed'
        })
      }

      sharedApp = undefined
      sharedPage = undefined
      sharedWorkerArtifactsDir = undefined
    },
    { scope: 'worker' }
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
    { scope: 'worker' }
  ]
})

/** Seed helpers — use the vanilla tRPC client to create test data without UI interaction. */
export function seed(page: Page) {
  return {
    createProject: (data: { name: string; color: string; path?: string }) =>
      page.evaluate((d) => window.getTrpcVanillaClient().projects.create.mutate(d), data),

    createTask: (data: {
      projectId: string
      title: string
      status?: string
      priority?: number
      dueDate?: string
    }) => page.evaluate((d) => window.getTrpcVanillaClient().task.create.mutate(d), data),

    updateTask: (data: {
      id: string
      status?: string
      priority?: number
      progress?: number
      dueDate?: string | null
    }) => page.evaluate((d) => window.getTrpcVanillaClient().task.update.mutate(d), data),

    deleteTask: (id: string) =>
      page.evaluate((i) => window.getTrpcVanillaClient().task.delete.mutate({ id: i }), id),

    archiveTask: (id: string) =>
      page.evaluate((i) => window.getTrpcVanillaClient().task.archive.mutate({ id: i }), id),

    archiveTasks: (ids: string[]) =>
      page.evaluate((i) => window.getTrpcVanillaClient().task.archiveMany.mutate({ ids: i }), ids),

    createTag: (data: { name: string; color?: string; textColor?: string; projectId?: string }) =>
      page.evaluate(async (d) => {
        const c = window.getTrpcVanillaClient()
        const projectId = d.projectId ?? (await c.projects.list.query())[0]?.id
        if (!projectId) {
          throw new Error('Cannot create tag without a project')
        }
        return c.tags.create.mutate({ ...d, projectId })
      }, data),

    updateTag: (data: { id: string; name?: string; color?: string; textColor?: string }) =>
      page.evaluate((d) => window.getTrpcVanillaClient().tags.update.mutate(d), data),

    deleteTag: (id: string) =>
      page.evaluate((i) => window.getTrpcVanillaClient().tags.delete.mutate({ id: i }), id),

    getTags: () => page.evaluate(() => window.getTrpcVanillaClient().tags.list.query()),

    setTagsForTask: (taskId: string, tagIds: string[]) =>
      page.evaluate(
        ({ t, tags }) =>
          window.getTrpcVanillaClient().tags.setForTask.mutate({ taskId: t, tagIds: tags }),
        { t: taskId, tags: tagIds }
      ),

    addBlocker: (taskId: string, blockerTaskId: string) =>
      page.evaluate(
        ({ t, b }) =>
          window.getTrpcVanillaClient().task.addBlocker.mutate({ taskId: t, blockerTaskId: b }),
        { t: taskId, b: blockerTaskId }
      ),

    getProjects: () => page.evaluate(() => window.getTrpcVanillaClient().projects.list.query()),

    getTasks: () => page.evaluate(() => window.getTrpcVanillaClient().task.getAll.query()),

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
    }) => page.evaluate((d) => window.getTrpcVanillaClient().projects.update.mutate(d), data),

    deleteProject: (id: string) =>
      page.evaluate((i) => window.getTrpcVanillaClient().projects.delete.mutate({ id: i }), id),

    deleteAllProjects: async () => {
      await page.evaluate(async () => {
        const c = window.getTrpcVanillaClient()
        const projects = await c.projects.list.query()
        for (const p of projects) await c.projects.delete.mutate({ id: p.id })
      })
    },

    setSetting: (key: string, value: string) =>
      page.evaluate(
        ({ k, v }) => window.getTrpcVanillaClient().settings.set.mutate({ key: k, value: v }),
        { k: key, v: value }
      ),

    getSetting: (key: string) =>
      page.evaluate((k) => window.getTrpcVanillaClient().settings.get.query({ key: k }), key),

    setTheme: (theme: 'light' | 'dark' | 'system') =>
      page.evaluate((t) => window.getTrpcVanillaClient().settings.setTheme.mutate(t), theme),

    // --- Artifacts ---

    createArtifact: (data: {
      taskId: string
      title: string
      content?: string
      folderId?: string | null
    }) => page.evaluate((d) => window.getTrpcVanillaClient().artifacts.create.mutate(d), data),

    getArtifacts: (taskId: string) =>
      page.evaluate((id) => window.getTrpcVanillaClient().artifacts.getByTask.query({ taskId: id }), taskId),

    deleteArtifact: (id: string) =>
      page.evaluate((i) => window.getTrpcVanillaClient().artifacts.delete.mutate({ id: i }), id),

    createArtifactFolder: (data: { taskId: string; name: string; parentId?: string | null }) =>
      page.evaluate((d) => window.getTrpcVanillaClient().artifacts.foldersCreate.mutate(d), data),

    getArtifactFolders: (taskId: string) =>
      page.evaluate(
        (id) => window.getTrpcVanillaClient().artifacts.foldersGetByTask.query({ taskId: id }),
        taskId
      ),

    /** Re-fetch all data from DB into React state */
    refreshData: () =>
      page.evaluate(async () => {
        await (window as any).__slayzone_refreshData?.()
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
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
      const clicked = await target
        .click({ timeout: 1_000 })
        .then(() => true)
        .catch(async () => {
          return await target
            .click({ force: true, timeout: 1_000 })
            .then(() => true)
            .catch(() => false)
        })
      if (clicked) return
    }
    await page.evaluate(async () => {
      const refresh = (window as { __slayzone_refreshData?: () => Promise<void> | void })
        .__slayzone_refreshData
      await refresh?.()
    })
    await page.waitForTimeout(100)
  }
  // Fallback: open command palette and select by query when sidebar badges are unavailable.
  await pressShortcut(page, 'search')
  const input = page.getByPlaceholder('Search files, folders, commands, projects, and tasks...')
  await input.fill(abbrev)
  await page.keyboard.press('Enter')
  await input.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
}

/** Click the + button in the sidebar to add a project */
export async function clickAddProject(page: Page) {
  const button = sidebar(page)
    .locator('button[aria-label="Add project"], button[title="Add project"], button[title^="Add project"]')
    .first()
  await button.click()
}

/** Click the settings button in the sidebar footer */
export async function clickSettings(page: Page) {
  const dialog = page.locator('[role="dialog"][aria-label="Settings"]').first()
  if (await dialog.isVisible({ timeout: 200 }).catch(() => false)) return

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.bringToFront().catch(() => {})

    await page.keyboard.press('Meta+,').catch(() => {})
    if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) return

    const sidebarSettingsButton = page
      .getByRole('button', { name: 'Settings', exact: true })
      .first()
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

/**
 * Open + ACTIVATE a task tab DETERMINISTICALLY by id, via the app's programmatic
 * opener (App exposes `window.__slayzone_openTask`), then wait for its detail panel to
 * mount. Use this in setup/beforeAll instead of goHome→clickProject→getByText(card).
 * .click(): under full-suite load that open is flaky in two ways —
 *   1. the project board may not be the visible view, so the task card resolves
 *      `hidden` (toBeVisible→hidden) and the whole describe's beforeAll throws; and
 *   2. a temporary "Terminal N" scratch task can be created + steal the active tab, so
 *      a later UNSCOPED panel/button interaction (only the active tab's panel is
 *      visible) lands on the WRONG task.
 * Opening by id can't target the wrong task and surfaces no dialog, so it is immune to
 * both. Bounded retry: the opener is exposed on App mount (throw→retry until it is),
 * and a generous budget tolerates slow mid-suite detail-panel paints.
 */
export async function openTaskById(page: Page, taskId: string): Promise<void> {
  await expect(async () => {
    await page.evaluate((id) => {
      const fn = (window as Window & { __slayzone_openTask?: (i: string) => void })
        .__slayzone_openTask
      if (!fn) throw new Error('__slayzone_openTask not exposed yet')
      fn(id)
    }, taskId)
    // Opening by id is deterministic, so a visible mode-trigger here is THIS task's.
    await expect(
      page.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 7_000 })
  }).toPass({ timeout: 40_000 })
}

/**
 * Surface a project's kanban board (home tab + project selected) and wait until a
 * known card is visible. For specs that test the BOARD itself (kanban cards), not a
 * task's detail — there `openTaskById` doesn't apply. A single `goHome → clickProject`
 * is unreliable under full-suite load: `goHome` no-ops if the home icon isn't queryable
 * within its short window, and a leftover active task tab then keeps the board (and its
 * cards) `hidden`. Retrying the whole nav against a real signal — the caller's own
 * target card — recovers from that without a brittle global board selector.
 */
export async function showProjectBoard(
  page: Page,
  projectAbbrev: string,
  cardText: string,
  timeout = 30_000
): Promise<void> {
  await expect(async () => {
    await goHome(page)
    await clickProject(page, projectAbbrev)
    await expect(page.getByText(cardText).first()).toBeVisible({ timeout: 4_000 })
  }).toPass({ timeout })
}

/**
 * Resolve a (non-temporary) task's id by its title, then open it via openTaskById.
 * Drop-in deterministic replacement for the old "type the title into the search
 * dialog + press Enter" open used across the git/terminal specs — that path was flaky
 * under full-suite load (Enter could select the wrong result, or the search flow could
 * spawn + activate a temporary "Terminal N" scratch task that captured the active tab).
 * Match is by EXACT title, which already excludes the auto-named "Terminal N" scratch
 * task; the most-recently-created match wins so re-used titles across describes resolve
 * to the freshly-seeded one. NOTE: do NOT filter out `is_temporary` — specs that
 * deliberately seed temporary tasks (e.g. 22-terminal-mode-switching) open them by
 * title too, and the exact-title match is what keeps the stray scratch task out.
 */
export async function openTaskByTitle(page: Page, title: string): Promise<void> {
  let id: string | null = null
  // Resolve under a retry: the task was just seeded, but getAll may briefly not reflect
  // it, and a single query can be slow under mid-suite load.
  await expect(async () => {
    id = await page.evaluate(async (t) => {
      const all = (await window.getTrpcVanillaClient().task.getAll.query()) as Array<{
        id: string
        title: string
        created_at?: string
      }>
      const matches = all
        .filter((x) => x.title === t)
        .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
      return matches.length ? matches[matches.length - 1].id : null
    }, title)
    if (!id) throw new Error(`openTaskByTitle: no task titled "${title}" yet`)
  }).toPass({ timeout: 15_000 })
  await openTaskById(page, id!)
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
  const openDialogs = page.locator(
    '[role="dialog"][data-state="open"], [role="dialog"][aria-modal="true"]'
  )
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
    if (await blob.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await blob.scrollIntoViewIfNeeded().catch(() => {})

      // Right-click → Settings via evaluate (fast, avoids Playwright actionability overhead)
      await blob
        .evaluate((node) => {
          node.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              button: 2,
              buttons: 2
            })
          )
        })
        .catch(() => {})

      const settingsItem = page.getByRole('menuitem', { name: 'Settings' }).first()
      if (await settingsItem.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await settingsItem.click({ force: true }).catch(() => {})
      }
    } else {
      const projectId = await page.evaluate((projectAbbrev) => {
        return window
          .getTrpcVanillaClient()
          .projects.list.query()
          .then(
            (projects) =>
              projects.find((project) => project.name.slice(0, 2).toUpperCase() === projectAbbrev)
                ?.id ?? null
          )
      }, abbrev)
      if (projectId) {
        await page
          .evaluate((id) => {
            window.dispatchEvent(
              new CustomEvent('open-project-settings', { detail: { projectId: id } })
            )
          }, projectId)
          .catch(() => {})
      }
    }

    if (await dialog.isVisible({ timeout: 1_500 }).catch(() => false)) break
    await page.waitForTimeout(150)
  }

  await expect(dialog).toBeVisible({ timeout: 5_000 })
  return dialog
}

export { expect }
