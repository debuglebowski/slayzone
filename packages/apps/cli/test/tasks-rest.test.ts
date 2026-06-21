/**
 * CLI → REST integration tests (post wave-3 swap).
 *
 * Spawns the bundled CLI (dist/slay.js) as a subprocess against an in-process
 * Express+REST stack on an ephemeral port. Subprocess is required because the
 * CLI source is loaded as CJS by tsx and pulls in @slayzone/* ESM modules; if
 * we direct-import CLI actions in this ESM test the REST routes' transitive
 * ESM imports trigger an unbreakable require(esm) cycle.
 *
 * Subprocess CLI hits localhost:<port> which routes through OUR registered
 * handlers — so taskEvents + ipcMain spies in this process still fire.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/apps/cli/test/tasks-rest.test.ts
 *
 * Pre-req: pnpm --filter @slayzone/cli build  (or rely on existing dist/slay.js)
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawn, execSync } from 'node:child_process'
import express from 'express'
import Database from 'better-sqlite3'
import { test, expect, describe, createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness.js'
import { configureTaskRuntimeAdapters } from '../../../domains/task/src/server/ops/shared.js'
import { mountRestApp } from '../../../shared/test-utils/rest-harness.js'
import { spyTaskEvents } from '../../../shared/test-utils/event-spy.js'
import { __ipcEmitCalls, __resetIpcEmitCalls } from '../../../shared/test-utils/mock-electron.js'
import { DB_PRAGMAS } from '../../../shared/platform/src/index.js'
import { taskEvents } from '../../../domains/task/src/server/events.js'
import { registerCreateTaskRoute } from '../../../shared/transport/src/server/http/rest-api/tasks/create.js'
import { registerUpdateTaskRoute } from '../../../shared/transport/src/server/http/rest-api/tasks/update.js'
import { registerArchiveTaskRoute } from '../../../shared/transport/src/server/http/rest-api/tasks/archive.js'
import { registerDeleteTaskRoute } from '../../../shared/transport/src/server/http/rest-api/tasks/delete.js'
import { registerUnarchiveTaskRoute } from '../../../shared/transport/src/server/http/rest-api/tasks/unarchive.js'
import { registerOpenTaskRoute } from '../../../shared/transport/src/server/http/rest-api/tasks/open.js'
import { BrowserWindow } from '../../../shared/test-utils/mock-electron.js'

const SLAY_BIN = path.resolve(import.meta.dirname, '../dist/slay.js')
if (!fs.existsSync(SLAY_BIN)) {
  console.error(`SKIP: dist/slay.js not built. Run \`pnpm --filter @slayzone/cli build\` first.`)
  process.exit(0)
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-rest-test-'))
const dbPath = path.join(tmpDir, 'slayzone.dev.sqlite')

const db = new Database(dbPath)
for (const pragma of DB_PRAGMAS) db.pragma(pragma)
const migrationsPath = path.resolve(
  import.meta.dirname,
  // Canonical schema moved out of apps/app/src/main/db in the Wave C2 split.
  '../../../shared/transport/src/db-bootstrap/migrations.ts'
)
const mod = await import(migrationsPath)
mod.runMigrations(db)
// The REST task ops are async (worker SlayzoneDb) + resolve their data root via
// the task runtime adapter — wrap the raw connection + configure the adapter so
// the mounted routes don't 500 (which would make the CLI subprocess exit 1).
const slayDb = createSlayzoneDbAdapter(db)
configureTaskRuntimeAdapters({ getDataRoot: () => tmpDir })

const projectId = crypto.randomUUID()
db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
  projectId,
  'CLIREST',
  '#000',
  tmpDir
)

let notifyCount = 0
const app = express()
app.use(express.json())
registerCreateTaskRoute(app, {
  db: slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
registerUpdateTaskRoute(app, {
  db: slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
registerArchiveTaskRoute(app, {
  db: slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
registerDeleteTaskRoute(app, {
  db: slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
registerUnarchiveTaskRoute(app, {
  db: slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
registerOpenTaskRoute(app, {
  db: slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
} as never)

// Capture app:open-task broadcasts + window show/focus calls.
const openTaskBroadcasts: Array<{ taskId: string; background: boolean }> = []
let showCalled = 0
let focusCalled = 0
const fakeWin = {
  webContents: {
    send: (channel: string, ...args: unknown[]) => {
      if (channel === 'app:open-task') {
        openTaskBroadcasts.push({ taskId: args[0] as string, background: args[1] as boolean })
      }
    }
  },
  isMinimized: () => false,
  restore: () => {},
  show: () => {
    showCalled++
  },
  focus: () => {
    focusCalled++
  }
}
;(BrowserWindow as unknown as { getAllWindows: () => unknown[] }).getAllWindows = () => [fakeWin]
function resetOpenSpies(): void {
  openTaskBroadcasts.length = 0
  showCalled = 0
  focusCalled = 0
}
const rest = await mountRestApp(app)

interface CliResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

function runCli(
  args: string[],
  envOverrides: Record<string, string | undefined> = {}
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      SLAYZONE_DB_PATH: dbPath,
      SLAYZONE_DEV: '1',
      SLAYZONE_MCP_PORT: String(rest.port)
    }
    for (const [k, v] of Object.entries(envOverrides)) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const p = spawn('node', [SLAY_BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    p.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    p.on('close', (code) => resolve({ exitCode: code, stdout, stderr }))
  })
}

await describe('CLI tasks create → REST', () => {
  test('happy: subprocess CLI hits POST /api/tasks; DB row appears; taskEvents fires', async () => {
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:created')
    notifyCount = 0
    const r = await runCli(['tasks', 'create', 'From CLI', '--project', 'CLIREST'])
    spy.stop()
    expect(r.exitCode).toBe(0)
    expect(r.stdout.startsWith('Created:')).toBe(true)
    const row = db.prepare('SELECT id, title FROM tasks WHERE title = ?').get('From CLI') as
      | { id: string; title: string }
      | undefined
    expect(row?.title).toBe('From CLI')
    expect(spy.calls.length).toBe(1)
    const emits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:create:done')
    expect(emits.length).toBeGreaterThanOrEqual(1)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('happy: --description, --priority, --status forwarded through REST', async () => {
    const r = await runCli([
      'tasks',
      'create',
      'Detailed',
      '--project',
      'CLIREST',
      '--description',
      'desc text',
      '--priority',
      '1',
      '--status',
      'todo'
    ])
    expect(r.exitCode).toBe(0)
    const row = db
      .prepare('SELECT title, description, priority, status FROM tasks WHERE title = ?')
      .get('Detailed') as { title: string; description: string; priority: number; status: string }
    expect(row.priority).toBe(1)
    expect(row.status).toBe('todo')
    expect(row.description).toBe('desc text')
  })

  test('error: unknown project → exits 1, helpful stderr', async () => {
    const r = await runCli(['tasks', 'create', 'NoProj', '--project', 'totally-not-a-project'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('No project matching')).toBe(true)
  })
})

await describe('CLI tasks update → REST', () => {
  test('happy: PATCH /api/tasks/:id; DB updates; taskEvents fires', async () => {
    const id = crypto.randomUUID()
    db.prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, projectId, 'OrigTitle', 'todo', 3, 0)
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:updated')
    const r = await runCli(['tasks', 'update', id, '--title', 'NewTitle'])
    spy.stop()
    expect(r.exitCode).toBe(0)
    const row = db.prepare('SELECT title FROM tasks WHERE id = ?').get(id) as { title: string }
    expect(row.title).toBe('NewTitle')
    expect(spy.calls.length).toBe(1)
    const emits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:update:done')
    expect(emits.length).toBeGreaterThanOrEqual(1)
  })
})

await describe('CLI tasks update --worktree-path', () => {
  function git(cmd: string, cwd: string): string {
    return execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 't@t.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 't@t.com'
      }
    }).trim()
  }

  test('happy: single-repo project — derives parent_branch, repo_name=null', async () => {
    const wtProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-wt-proj-'))
    git('git init -q -b main', wtProjectDir)
    fs.writeFileSync(path.join(wtProjectDir, 'README.md'), '#')
    git('git add -A', wtProjectDir)
    git('git -c commit.gpgsign=false commit -qm init', wtProjectDir)

    const wtProjectId = crypto.randomUUID()
    db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
      wtProjectId,
      'WTPROJ',
      '#000',
      wtProjectDir
    )

    const wtPath = path.join(os.tmpdir(), `slay-wt-${crypto.randomUUID().slice(0, 8)}`)
    git(`git worktree add -b feature-x ${wtPath}`, wtProjectDir)

    const taskId = crypto.randomUUID()
    db.prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
    ).run(taskId, wtProjectId, 'Link me', 'todo', 3, 0)

    const r = await runCli(['tasks', 'update', taskId, '--worktree-path', wtPath])
    expect(r.exitCode).toBe(0)

    const row = db
      .prepare('SELECT worktree_path, worktree_parent_branch, repo_name FROM tasks WHERE id = ?')
      .get(taskId) as {
      worktree_path: string
      worktree_parent_branch: string
      repo_name: string | null
    }
    expect(row.worktree_path).toBe(path.resolve(wtPath))
    expect(row.worktree_parent_branch).toBe('main')
    expect(row.repo_name).toBeNull()

    git(`git worktree remove --force ${wtPath}`, wtProjectDir)
    fs.rmSync(wtProjectDir, { recursive: true, force: true })
  })

  test('happy: multi-repo project — repo_name set to child repo dir', async () => {
    const wtProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-wt-multi-'))
    const childRepo = path.join(wtProjectDir, 'svc-a')
    fs.mkdirSync(childRepo, { recursive: true })
    git('git init -q -b main', childRepo)
    fs.writeFileSync(path.join(childRepo, 'README.md'), '#')
    git('git add -A', childRepo)
    git('git -c commit.gpgsign=false commit -qm init', childRepo)

    const wtProjectId = crypto.randomUUID()
    db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
      wtProjectId,
      'WTMULTI',
      '#000',
      wtProjectDir
    )

    const wtPath = path.join(os.tmpdir(), `slay-wt-${crypto.randomUUID().slice(0, 8)}`)
    git(`git worktree add -b feature-y ${wtPath}`, childRepo)

    const taskId = crypto.randomUUID()
    db.prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
    ).run(taskId, wtProjectId, 'Multi link', 'todo', 3, 0)

    const r = await runCli(['tasks', 'update', taskId, '--worktree-path', wtPath])
    expect(r.exitCode).toBe(0)

    const row = db
      .prepare('SELECT worktree_path, worktree_parent_branch, repo_name FROM tasks WHERE id = ?')
      .get(taskId) as {
      worktree_path: string
      worktree_parent_branch: string
      repo_name: string | null
    }
    expect(row.worktree_path).toBe(path.resolve(wtPath))
    expect(row.worktree_parent_branch).toBe('main')
    expect(row.repo_name).toBe('svc-a')

    git(`git worktree remove --force ${wtPath}`, childRepo)
    fs.rmSync(wtProjectDir, { recursive: true, force: true })
  })

  test('error: path not a git worktree', async () => {
    const bogus = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-wt-bogus-'))
    const taskId = crypto.randomUUID()
    db.prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
    ).run(taskId, projectId, 'Bogus link', 'todo', 3, 0)
    const r = await runCli(['tasks', 'update', taskId, '--worktree-path', bogus])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Not a git worktree')).toBe(true)
    fs.rmSync(bogus, { recursive: true, force: true })
  })

  test('error: worktree not owned by any project repo', async () => {
    const wtProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-wt-orphan-'))
    git('git init -q -b main', wtProjectDir)
    fs.writeFileSync(path.join(wtProjectDir, 'README.md'), '#')
    git('git add -A', wtProjectDir)
    git('git -c commit.gpgsign=false commit -qm init', wtProjectDir)

    const wtProjectId = crypto.randomUUID()
    db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
      wtProjectId,
      'WTORPH',
      '#000',
      wtProjectDir
    )

    // Worktree under a foreign repo
    const foreignRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-wt-foreign-'))
    git('git init -q -b main', foreignRepo)
    fs.writeFileSync(path.join(foreignRepo, 'README.md'), '#')
    git('git add -A', foreignRepo)
    git('git -c commit.gpgsign=false commit -qm init', foreignRepo)
    const wtPath = path.join(os.tmpdir(), `slay-wt-${crypto.randomUUID().slice(0, 8)}`)
    git(`git worktree add -b feature-z ${wtPath}`, foreignRepo)

    const taskId = crypto.randomUUID()
    db.prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
    ).run(taskId, wtProjectId, 'Orphan link', 'todo', 3, 0)

    const r = await runCli(['tasks', 'update', taskId, '--worktree-path', wtPath])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('does not belong to any repo')).toBe(true)

    git(`git worktree remove --force ${wtPath}`, foreignRepo)
    fs.rmSync(wtProjectDir, { recursive: true, force: true })
    fs.rmSync(foreignRepo, { recursive: true, force: true })
  })
})

await describe('CLI tasks archive → REST', () => {
  test('happy: POST /api/tasks/:id/archive; DB archived_at set; taskEvents fires', async () => {
    const id = crypto.randomUUID()
    db.prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, projectId, 'ToArchive', 'todo', 3, 0)
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:archived')
    const r = await runCli(['tasks', 'archive', id])
    spy.stop()
    expect(r.exitCode).toBe(0)
    const row = db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(id) as {
      archived_at: string | null
    }
    expect(row.archived_at !== null).toBe(true)
    expect(spy.calls.length).toBe(1)
  })
})

await describe('CLI tasks open → REST /api/open-task', () => {
  // Create a task once to reuse across these tests.
  const openTaskId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, "order", created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(openTaskId, projectId, 'OpenMe', 'todo', 3, 'claude-code', '{}', now, now)

  test('default (no flag): broadcasts (id, false) + main window show/focus', async () => {
    resetOpenSpies()
    const r = await runCli(['tasks', 'open', openTaskId.slice(0, 8)])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.startsWith('Opening:')).toBe(true)
    expect(openTaskBroadcasts.length).toBe(1)
    expect(openTaskBroadcasts[0].taskId).toBe(openTaskId)
    expect(openTaskBroadcasts[0].background).toBe(false)
    expect(showCalled).toBe(1)
    expect(focusCalled).toBe(1)
  })

  test('--background: broadcasts (id, true) + no show/focus', async () => {
    resetOpenSpies()
    const r = await runCli(['tasks', 'open', openTaskId.slice(0, 8), '--background'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.startsWith('Opening (bg):')).toBe(true)
    expect(openTaskBroadcasts.length).toBe(1)
    expect(openTaskBroadcasts[0].taskId).toBe(openTaskId)
    expect(openTaskBroadcasts[0].background).toBe(true)
    expect(showCalled).toBe(0)
    expect(focusCalled).toBe(0)
  })
})

await describe('CLI app-down path', () => {
  test('apiPost exits with helpful stderr when REST unreachable', async () => {
    // Reserved port 1 — connection refused immediately
    const r = await runCli(['tasks', 'create', 'Lost', '--project', 'CLIREST'], {
      SLAYZONE_MCP_PORT: '1'
    })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('not running') || r.stderr.includes('could not connect')).toBe(true)
  })

  test('exits when no MCP port configured at all (env unset, settings empty)', async () => {
    db.prepare("DELETE FROM settings WHERE key = 'mcp_server_port'").run()
    const r = await runCli(['tasks', 'create', 'Lost2', '--project', 'CLIREST'], {
      SLAYZONE_MCP_PORT: undefined
    })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('MCP port not found')).toBe(true)
  })
})

await rest.close()
db.close()
fs.rmSync(tmpDir, { recursive: true, force: true })
