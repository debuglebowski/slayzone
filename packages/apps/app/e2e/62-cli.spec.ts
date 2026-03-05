import { test, expect, seed, clickProject, goHome, TEST_PROJECT_PATH } from './fixtures/electron'
import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SLAY_JS = path.resolve(__dirname, '..', '..', 'cli', 'dist', 'slay.js')

test.describe('CLI: slay', () => {
  let dbPath = ''
  let projectId = ''
  let mcpPort = 0
  const PROJECT_ABBREV = 'CL'

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    if (!fs.existsSync(SLAY_JS)) {
      throw new Error(`CLI not built. Run: pnpm --filter @slayzone/cli build\nExpected: ${SLAY_JS}`)
    }

    // Get the exact DB path the running app is using
    const dbDir = await electronApp.evaluate(() => process.env.SLAYZONE_DB_DIR!)
    // Tests always run non-packaged, so DB name is always slayzone.dev.sqlite
    dbPath = path.join(dbDir, 'slayzone.dev.sqlite')

    // Discover dynamic MCP port
    mcpPort = await electronApp.evaluate(async () => {
      for (let i = 0; i < 20; i++) {
        const p = (globalThis as Record<string, unknown>).__mcpPort
        if (p) return p as number
        await new Promise((r) => setTimeout(r, 250))
      }
      return 0
    })
    expect(mcpPort).toBeTruthy()

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'CLI Test', color: '#10b981', path: TEST_PROJECT_PATH })
    projectId = p.id

    await s.createTask({ projectId, title: 'CLI seeded todo task', status: 'todo' })
    await s.createTask({ projectId, title: 'CLI seeded done task', status: 'done' })
    await s.createTask({ projectId, title: 'CLI seeded in progress task', status: 'in_progress' })

    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, PROJECT_ABBREV)
  })

  const runCli = (...args: string[]) =>
    spawnSync('node', [SLAY_JS, ...args], {
      env: { ...process.env, SLAYZONE_DB_PATH: dbPath, SLAYZONE_MCP_PORT: String(mcpPort) },
      encoding: 'utf8',
    })

  // --- slay tasks list ---

  test.describe('slay tasks list', () => {
    test('lists all tasks', () => {
      const r = runCli('tasks', 'list')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('CLI seeded todo task')
      expect(r.stdout).toContain('CLI seeded done task')
      expect(r.stdout).toContain('CLI seeded in progress task')
    })

    test('--status filters tasks', () => {
      const r = runCli('tasks', 'list', '--status', 'todo')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('CLI seeded todo task')
      expect(r.stdout).not.toContain('CLI seeded in progress task')
    })

    test('--done shows only done tasks', () => {
      const r = runCli('tasks', 'list', '--done')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('CLI seeded done task')
      expect(r.stdout).not.toContain('CLI seeded todo task')
    })

    test('--project filters by project name', () => {
      const r = runCli('tasks', 'list', '--project', 'cli test')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('CLI seeded todo task')
    })

    test('--json outputs valid JSON array', () => {
      const r = runCli('tasks', 'list', '--json')
      expect(r.status).toBe(0)
      const tasks = JSON.parse(r.stdout)
      expect(Array.isArray(tasks)).toBe(true)
      expect(tasks.some((t: { title: string }) => t.title === 'CLI seeded todo task')).toBe(true)
    })

    test('--limit caps results', () => {
      const r = runCli('tasks', 'list', '--json', '--limit', '1')
      expect(r.status).toBe(0)
      const tasks = JSON.parse(r.stdout)
      expect(tasks).toHaveLength(1)
    })
  })

  // --- slay tasks create ---

  test.describe('slay tasks create', () => {
    test('creates task and UI updates automatically via REST notify', async ({ mainWindow }) => {
      const title = `CLI created ${Date.now()}`
      const r = runCli('tasks', 'create', title, '--project', 'cli test')
      expect(r.status).toBe(0)

      // CLI POSTs /api/notify → tasks:changed → refreshData → React re-renders — no manual refresh needed
      await expect(mainWindow.getByText(title)).toBeVisible({ timeout: 5_000 })
    })

    test('exits non-zero and mentions --project when flag is missing', () => {
      const r = runCli('tasks', 'create', 'No project task')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('--project')
    })
  })

  // --- slay projects list ---

  test.describe('slay projects list', () => {
    test('lists projects with task counts', () => {
      const r = runCli('projects', 'list')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('CLI Test')
    })

    test('--json outputs valid JSON array', () => {
      const r = runCli('projects', 'list', '--json')
      expect(r.status).toBe(0)
      const projects = JSON.parse(r.stdout)
      expect(Array.isArray(projects)).toBe(true)
      expect(projects.some((p: { name: string }) => p.name === 'CLI Test')).toBe(true)
    })
  })

  // --- slay projects create ---

  test.describe('slay projects create', () => {
    test('creates project with path and color', () => {
      const name = `CLI project ${Date.now()}`
      const projectPath = path.join(TEST_PROJECT_PATH, `cli-project-${Date.now()}`)

      const createdResult = runCli('projects', 'create', name, '--path', projectPath, '--color', '#22c55e', '--json')
      expect(createdResult.status).toBe(0)
      const created = JSON.parse(createdResult.stdout) as { name: string; color: string; path: string | null }

      expect(created.name).toBe(name)
      expect(created.color).toBe('#22c55e')
      expect(created.path).toBe(projectPath)
      expect(fs.existsSync(projectPath)).toBe(true)
      expect(fs.statSync(projectPath).isDirectory()).toBe(true)

      const listResult = runCli('projects', 'list', '--json')
      const projects = JSON.parse(listResult.stdout) as Array<{ name: string }>
      expect(projects.some((p) => p.name === name)).toBe(true)
    })

    test('exits non-zero for invalid color value', () => {
      const r = runCli('projects', 'create', `Invalid color ${Date.now()}`, '--color', '#0f0')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('Expected format: #RRGGBB')
    })
  })

  // --- slay tasks update ---

  test.describe('slay tasks update', () => {
    test('updates task title', () => {
      const r0 = runCli('tasks', 'list', '--project', 'cli test', '--json')
      const tasks = JSON.parse(r0.stdout)
      const task = tasks.find((t: { title: string }) => t.title === 'CLI seeded todo task')
      const r = runCli('tasks', 'update', task.id.slice(0, 8), '--title', 'CLI renamed task')
      expect(r.status).toBe(0)
      const r2 = runCli('tasks', 'list', '--json')
      expect(JSON.parse(r2.stdout).some((t: { title: string }) => t.title === 'CLI renamed task')).toBe(true)
    })

    test('updates task status', () => {
      const r0 = runCli('tasks', 'list', '--json')
      const tasks = JSON.parse(r0.stdout)
      const task = tasks.find((t: { title: string }) => t.title === 'CLI seeded in progress task')
      const r = runCli('tasks', 'update', task.id.slice(0, 8), '--status', 'review')
      expect(r.status).toBe(0)
      const r2 = runCli('tasks', 'list', '--status', 'review', '--json')
      expect(JSON.parse(r2.stdout).some((t: { title: string }) => t.title === 'CLI seeded in progress task')).toBe(true)
    })

    test('exits non-zero with no options', () => {
      const r = runCli('tasks', 'update', 'xxxxxxxx')
      expect(r.status).not.toBe(0)
    })

    test('exits non-zero on unknown id prefix', () => {
      const r = runCli('tasks', 'update', 'xxxxxxxx', '--status', 'todo')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('not found')
    })
  })

  // --- slay tasks archive ---

  test.describe('slay tasks archive', () => {
    test('archives task and it disappears from list', () => {
      const title = `CLI archive test ${Date.now()}`
      runCli('tasks', 'create', title, '--project', 'cli test')
      const r0 = runCli('tasks', 'list', '--json')
      const task = JSON.parse(r0.stdout).find((t: { title: string }) => t.title === title)
      expect(task).toBeDefined()

      const r = runCli('tasks', 'archive', task.id.slice(0, 8))
      expect(r.status).toBe(0)

      const r2 = runCli('tasks', 'list', '--json')
      expect(JSON.parse(r2.stdout).some((t: { title: string }) => t.title === title)).toBe(false)
    })
  })

  // --- slay tasks delete ---

  test.describe('slay tasks delete', () => {
    test('deletes task permanently', () => {
      const title = `CLI delete test ${Date.now()}`
      runCli('tasks', 'create', title, '--project', 'cli test')
      const r0 = runCli('tasks', 'list', '--json')
      const task = JSON.parse(r0.stdout).find((t: { title: string }) => t.title === title)
      expect(task).toBeDefined()

      const r = runCli('tasks', 'delete', task.id.slice(0, 8))
      expect(r.status).toBe(0)

      const r2 = runCli('tasks', 'list', '--json')
      expect(JSON.parse(r2.stdout).some((t: { title: string }) => t.title === title)).toBe(false)
    })

    test('exits non-zero on unknown id prefix', () => {
      const r = runCli('tasks', 'delete', 'xxxxxxxx')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('not found')
    })
  })

  // --- slay tasks open ---

  test.describe('slay tasks open', () => {
    test('outputs Opening: for a valid task id', () => {
      const r0 = runCli('tasks', 'list', '--json')
      const tasks = JSON.parse(r0.stdout)
      const task = tasks[0]
      const r = runCli('tasks', 'open', task.id.slice(0, 8))
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('Opening:')
    })

    test('exits non-zero on unknown id prefix', () => {
      const r = runCli('tasks', 'open', 'xxxxxxxx')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('not found')
    })
  })

  // --- slay tasks done ---

  test.describe('slay tasks done', () => {
    test('marks task done and UI updates automatically via REST notify', async ({ mainWindow }) => {
      const s = seed(mainWindow)
      const task = await s.createTask({ projectId, title: 'Task to complete via CLI', status: 'todo' })
      await s.refreshData()
      // Locate the todo column by its w-72 class + heading; task should be visible there
      const todoCol = mainWindow.locator('div.w-72').filter({ has: mainWindow.locator('h3', { hasText: 'Todo' }) })
      await expect(todoCol.getByText('Task to complete via CLI')).toBeVisible({ timeout: 5_000 })

      const r = runCli('tasks', 'done', task.id.slice(0, 8))
      expect(r.status).toBe(0)

      // CLI POSTs /api/notify → tasks:changed → refreshData → task moves from todo to done column
      await expect(todoCol.getByText('Task to complete via CLI')).not.toBeVisible({ timeout: 5_000 })
    })

    test('exits non-zero on unknown id prefix', () => {
      const r = runCli('tasks', 'done', 'xxxxxxxx')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('not found')
    })
  })

  // --- slay processes ---

  test.describe('slay processes', () => {
    let processId = ''

    test.beforeAll(async ({ electronApp }) => {
      // Spawn a short-lived process via test global exposed in Playwright mode
      processId = await electronApp.evaluate(() => {
        const spawn = (globalThis as Record<string, unknown>).__spawnProcess as (
          projectId: string | null, taskId: string | null, label: string, command: string, cwd: string, autoRestart: boolean
        ) => string
        return spawn(null, null, 'CLI test process', 'echo hello-from-slay-cli', '/tmp', false)
      })
      // Give it a moment to produce output
      await new Promise((r) => setTimeout(r, 300))
    })

    const runProcessesCli = (...args: string[]) =>
      spawnSync('node', [SLAY_JS, ...args], {
        env: { ...process.env, SLAYZONE_DB_PATH: dbPath, SLAYZONE_MCP_PORT: String(mcpPort) },
        encoding: 'utf8',
      })

    test('lists processes', () => {
      const r = runProcessesCli('processes', 'list')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('CLI test process')
    })

    test('--json outputs valid JSON array', () => {
      const r = runProcessesCli('processes', 'list', '--json')
      expect(r.status).toBe(0)
      const procs = JSON.parse(r.stdout)
      expect(Array.isArray(procs)).toBe(true)
      expect(procs.some((p: { label: string }) => p.label === 'CLI test process')).toBe(true)
    })

    test('shows logs for a process', () => {
      const r = runProcessesCli('processes', 'logs', processId.slice(0, 8))
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('hello-from-slay-cli')
    })

    test('logs exits non-zero on unknown id prefix', () => {
      const r = runProcessesCli('processes', 'logs', 'xxxxxxxx')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('not found')
    })

    test('exits non-zero when app is not running', () => {
      const r = spawnSync('node', [SLAY_JS, 'processes', 'list'], {
        env: { ...process.env, SLAYZONE_DB_PATH: dbPath, SLAYZONE_MCP_PORT: '1' },
        encoding: 'utf8',
      })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('not running')
    })

    test('kill stops a process', () => {
      // Spawn a long-running process for this test
      const killId = spawnSync('node', [SLAY_JS, 'tasks', 'list'], {
        env: { ...process.env, SLAYZONE_DB_PATH: dbPath },
        encoding: 'utf8',
      }) // warmup — ignore result
      void killId

      // Use electronApp.evaluate to spawn
      // We'll use the processId from beforeAll and just verify kill works on a fresh one
      // Spawn inline via API
      const freshId = runProcessesCli('processes', 'list', '--json')
      const before = JSON.parse(freshId.stdout) as { id: string; label: string }[]
      expect(before.some((p) => p.label === 'CLI test process')).toBe(true)

      const target = before.find((p) => p.label === 'CLI test process')!
      const r = runProcessesCli('processes', 'kill', target.id.slice(0, 8))
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('Killed:')

      const after = JSON.parse(runProcessesCli('processes', 'list', '--json').stdout) as { id: string }[]
      expect(after.some((p) => p.id === target.id)).toBe(false)
    })

    test('kill exits non-zero on unknown id', () => {
      const r = runProcessesCli('processes', 'kill', 'xxxxxxxx')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('not found')
    })

    test('follow prints buffer for a finished process and exits', async ({ electronApp }) => {
      // Spawn a process that finishes quickly
      const followId = await electronApp.evaluate(() => {
        const spawn = (globalThis as Record<string, unknown>).__spawnProcess as (
          projectId: string | null, taskId: string | null, label: string, command: string, cwd: string, autoRestart: boolean
        ) => string
        return spawn(null, null, 'CLI follow test', 'echo follow-output-marker', '/tmp', false)
      })
      // Wait for it to complete
      await new Promise((r) => setTimeout(r, 400))

      const r = runProcessesCli('processes', 'follow', followId.slice(0, 8))
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('follow-output-marker')
    })

    test('follow exits non-zero on unknown id', () => {
      const r = runProcessesCli('processes', 'follow', 'xxxxxxxx')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('not found')
    })
  })

  // --- slay tasks subtasks ---

  test.describe('slay tasks subtasks + subtask-add + search', () => {
    let parentTaskId = ''

    test.beforeAll(async ({ mainWindow }) => {
      const s = seed(mainWindow)
      const parent = await s.createTask({ projectId, title: 'CLI subtask parent', status: 'todo' })
      parentTaskId = parent.id
      // Create a subtask via the API
      await (mainWindow.evaluate as (fn: (d: unknown) => unknown, d: unknown) => Promise<unknown>)(
        (d) => window.api.db.createTask(d as Parameters<typeof window.api.db.createTask>[0]),
        { projectId, title: 'CLI seeded subtask', status: 'todo', parentId: parent.id }
      )
      await s.refreshData()
    })

    test('subtasks lists subtasks of a task', () => {
      const r = runCli('tasks', 'subtasks', parentTaskId.slice(0, 8))
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('CLI seeded subtask')
    })

    test('subtasks --json outputs array', () => {
      const r = runCli('tasks', 'subtasks', parentTaskId.slice(0, 8), '--json')
      expect(r.status).toBe(0)
      const subtasks = JSON.parse(r.stdout)
      expect(Array.isArray(subtasks)).toBe(true)
      expect(subtasks.some((t: { title: string }) => t.title === 'CLI seeded subtask')).toBe(true)
    })

    test('subtask-add creates a subtask', () => {
      const title = `CLI new subtask ${Date.now()}`
      const r = runCli('tasks', 'subtask-add', parentTaskId.slice(0, 8), title)
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('Created subtask:')

      const r2 = runCli('tasks', 'subtasks', parentTaskId.slice(0, 8), '--json')
      const subtasks = JSON.parse(r2.stdout) as { title: string }[]
      expect(subtasks.some((t) => t.title === title)).toBe(true)
    })

    test('search finds tasks by title', () => {
      const r = runCli('tasks', 'search', 'CLI seeded done')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('CLI seeded done task')
    })

    test('search --json returns array', () => {
      const r = runCli('tasks', 'search', 'CLI seeded done', '--json')
      expect(r.status).toBe(0)
      const tasks = JSON.parse(r.stdout)
      expect(Array.isArray(tasks)).toBe(true)
      expect(tasks.length).toBeGreaterThan(0)
    })

    test('search with no match returns empty', () => {
      const r = runCli('tasks', 'search', 'xyzzy-no-match-ever-12345', '--json')
      expect(r.status).toBe(0)
      expect(JSON.parse(r.stdout)).toHaveLength(0)
    })
  })

  // --- slay completions ---

  test.describe('slay completions', () => {
    test('fish completions exits 0 and contains complete -c slay', () => {
      const r = runCli('completions', 'fish')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('complete -c slay')
    })

    test('zsh completions exits 0 and contains compdef', () => {
      const r = runCli('completions', 'zsh')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('compdef _slay slay')
    })

    test('bash completions exits 0 and contains complete -F', () => {
      const r = runCli('completions', 'bash')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('complete -F _slay_completions slay')
    })

    test('unknown shell exits non-zero', () => {
      const r = runCli('completions', 'powershell')
      expect(r.status).not.toBe(0)
    })
  })
})
