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
import * as http from 'node:http'
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
import {
  DB_PRAGMAS,
  SIDECAR_FIXED_PORT,
  getDbName,
  getStorageDir
} from '../../../shared/platform/src/index.js'
import { taskEvents } from '../../../domains/task/src/server/events.js'
import { registerCreateTaskRoute } from '../../../shared/transport/src/server/http/rest-api/tasks/create.js'
import { registerUpdateTaskRoute } from '../../../shared/transport/src/server/http/rest-api/tasks/update.js'
import { registerArchiveTaskRoute } from '../../../shared/transport/src/server/http/rest-api/tasks/archive.js'
import { registerDeleteTaskRoute } from '../../../shared/transport/src/server/http/rest-api/tasks/delete.js'
import { registerUnarchiveTaskRoute } from '../../../shared/transport/src/server/http/rest-api/tasks/unarchive.js'
import { registerOpenTaskRoute } from '../../../shared/transport/src/server/http/rest-api/tasks/open.js'
// `tasks update --worktree-path` reads the project path from the task detail
// route (it must not open the hub's DB file), so that route has to be mounted here.
import { registerGetTaskRoute } from '../../../shared/transport/src/server/http/rest-api/tasks/get.js'
import { BrowserWindow, ipcMain } from '../../../shared/test-utils/mock-electron.js'

const SLAY_BIN = path.resolve(import.meta.dirname, '../dist/slay.js')
if (!fs.existsSync(SLAY_BIN)) {
  console.error(`SKIP: dist/slay.js not built. Run \`pnpm --filter @slayzone/cli build\` first.`)
  process.exit(0)
}

/**
 * The storage dir a process anchored at `root` resolves — derived by running the
 * production resolver against that root rather than spelling the layout out here.
 * It is `<ROOT>` itself today (the `storage/` subfolder went away when the root
 * became role-scoped), and every hardcoded `'storage'` segment in this file
 * silently pointed its assertions at a directory nothing writes to.
 */
function storageDirFor(root: string): string {
  const prev = process.env.SLAYZONE_ROOT
  process.env.SLAYZONE_ROOT = root
  try {
    return getStorageDir()
  } finally {
    if (prev === undefined) delete process.env.SLAYZONE_ROOT
    else process.env.SLAYZONE_ROOT = prev
  }
}

// tmpDir is the install ROOT handed to the CLI; the DB filename is the `.dev` one
// (SLAYZONE_DEV=1 below), and it sits directly in that root's storage dir.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-rest-test-'))
const storageDir = storageDirFor(tmpDir)
fs.mkdirSync(storageDir, { recursive: true })

const db = new Database(path.join(storageDir, getDbName(false)))
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
// The task ops emit their `db:tasks:*:done` completion events through an injected
// `taskBus` (dep-injection refactor — they no longer import `electron` directly).
// Wire mock-electron's `ipcMain` as that bus so its emits land in `__ipcEmitCalls`
// for the assertions below; without it the routes fall back to NOOP_TASK_BUS and
// nothing is captured.
const taskBus = ipcMain as unknown as { emit: (channel: string, ...args: unknown[]) => boolean }
registerCreateTaskRoute(app, {
  db: slayDb,
  taskBus,
  notifyRenderer: () => {
    notifyCount++
  }
})
registerUpdateTaskRoute(app, {
  db: slayDb,
  taskBus,
  notifyRenderer: () => {
    notifyCount++
  }
})
registerArchiveTaskRoute(app, {
  db: slayDb,
  taskBus,
  notifyRenderer: () => {
    notifyCount++
  }
})
registerDeleteTaskRoute(app, {
  db: slayDb,
  taskBus,
  notifyRenderer: () => {
    notifyCount++
  }
})
registerUnarchiveTaskRoute(app, {
  db: slayDb,
  taskBus,
  notifyRenderer: () => {
    notifyCount++
  }
})
registerGetTaskRoute(app, {
  db: slayDb,
  taskBus,
  notifyRenderer: () => {
    notifyCount++
  }
})

// Capture app:open-task broadcasts + window show/focus calls. The open route no
// longer reaches into `electron` directly — it emits via injected `legacyBroadcast`
// (test-only spy) + `windowActions` (raise/show/focus). Wire both so the spies fire.
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

registerOpenTaskRoute(app, {
  db: slayDb,
  notifyRenderer: () => {
    notifyCount++
  },
  legacyBroadcast: (channel: string, ...args: unknown[]) =>
    fakeWin.webContents.send(channel, ...args),
  windowActions: {
    raiseMainWindow: () => {
      fakeWin.show()
      fakeWin.focus()
    }
  }
} as never)
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
      SLAYZONE_ROOT: tmpDir,
      SLAYZONE_DEV: '1',
      // Authority only (host:port) — the http scheme derives from SLAYZONE_MODE.
      SLAYZONE_HUB_ADDRESS: `127.0.0.1:${rest.port}`
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

/**
 * Bind a NON-hub listener on one of the two fixed sidecar ports, so the CLI's
 * local-hub probe for that channel deterministically finds nothing dialable.
 *
 * Tries the dev port first (the channel every other test in this file uses) and
 * falls back to the prod port, since a developer box is usually running a real
 * dev sidecar on 51101. `dev` reports which one was claimed so the caller can set
 * SLAYZONE_DEV to match. Throws — loudly — when both are taken, rather than
 * letting the assertion silently exercise a live app.
 */
async function occupyFixedPort(): Promise<{ dev: boolean; close: () => Promise<void> }> {
  for (const [port, dev] of [
    [SIDECAR_FIXED_PORT.dev, true],
    [SIDECAR_FIXED_PORT.prod, false]
  ] as const) {
    // 404 on everything: `findHub` requires a 200 with a hub-shaped body.
    const server = http.createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not a hub')
    })
    const bound = await new Promise<boolean>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off('error', onError)
        if (err.code === 'EADDRINUSE') resolve(false)
        else reject(err)
      }
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError)
        resolve(true)
      })
    })
    if (!bound) continue
    return {
      dev,
      close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  throw new Error(
    `Both fixed sidecar ports (${SIDECAR_FIXED_PORT.dev}, ${SIDECAR_FIXED_PORT.prod}) are in use — ` +
      `cannot prove the "no hub answers" path. Stop one of the running hubs and re-run.`
  )
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

/**
 * Id-PREFIX addressing over REST only. These run with `SLAYZONE_ROOT` pointed at a
 * directory that has NO database file, which is the whole point: the CLI used to
 * open the hub's SQLite file to expand a prefix, so a hub on another machine
 * (where that file does not exist) died on `openDb()`'s "Database not found"
 * `process.exit(1)`. The hub still has the DB; this CLI does not.
 */
await describe('CLI id-prefix addressing works without a local database', () => {
  const noDbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-no-db-'))
  const noDbEnv = { SLAYZONE_ROOT: noDbRoot }

  function seed(title: string, id = crypto.randomUUID()): string {
    db.prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, projectId, title, 'todo', 3, 0)
    return id
  }

  test('sanity: this root really has no database file', () => {
    expect(fs.existsSync(path.join(storageDirFor(noDbRoot), getDbName(false)))).toBe(false)
  })

  test('tasks update <prefix> --title', async () => {
    const id = seed('PrefixUpdate')
    const r = await runCli(['tasks', 'update', id.slice(0, 8), '--title', 'Renamed'], noDbEnv)
    expect(r.exitCode).toBe(0)
    const row = db.prepare('SELECT title FROM tasks WHERE id = ?').get(id) as { title: string }
    expect(row.title).toBe('Renamed')
  })

  test('tasks update <prefix> --status accepts a label alias', async () => {
    const id = seed('PrefixStatus')
    const r = await runCli(['tasks', 'update', id.slice(0, 8), '--status', 'In Progress'], noDbEnv)
    expect(r.exitCode).toBe(0)
    const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }
    expect(row.status).toBe('in_progress')
  })

  test('tasks update: unknown status exits 1 with the CLI wording', async () => {
    const id = seed('PrefixBadStatus')
    const r = await runCli(['tasks', 'update', id.slice(0, 8), '--status', 'nonsense'], noDbEnv)
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes(`Unknown status "nonsense" for this task's project.`)).toBe(true)
  })

  test('tasks update <prefix> --parent <prefix> reparents', async () => {
    const parent = seed('PrefixParent')
    const child = seed('PrefixChild')
    const r = await runCli(
      ['tasks', 'update', child.slice(0, 8), '--parent', parent.slice(0, 8)],
      noDbEnv
    )
    expect(r.exitCode).toBe(0)
    const row = db.prepare('SELECT parent_id FROM tasks WHERE id = ?').get(child) as {
      parent_id: string
    }
    expect(row.parent_id).toBe(parent)
  })

  test('tasks update: unknown parent exits 1 naming the PARENT', async () => {
    const id = seed('PrefixBadParent')
    const r = await runCli(
      ['tasks', 'update', id.slice(0, 8), '--parent', 'no-such-parent'],
      noDbEnv
    )
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Parent task not found: no-such-parent')).toBe(true)
  })

  test('tasks update <prefix> --append-description appends to the stored text', async () => {
    const id = seed('PrefixAppend')
    db.prepare('UPDATE tasks SET description = ? WHERE id = ?').run('line one', id)
    const r = await runCli(
      ['tasks', 'update', id.slice(0, 8), '--append-description', 'line two'],
      noDbEnv
    )
    expect(r.exitCode).toBe(0)
    const row = db.prepare('SELECT description FROM tasks WHERE id = ?').get(id) as {
      description: string
    }
    expect(row.description).toBe('line one\nline two')
  })

  test('tasks archive <prefix>', async () => {
    const id = seed('PrefixArchive')
    const r = await runCli(['tasks', 'archive', id.slice(0, 8)], noDbEnv)
    expect(r.exitCode).toBe(0)
    expect(r.stdout.includes(`Archived: ${id.slice(0, 8)}  PrefixArchive`)).toBe(true)
    const row = db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(id) as {
      archived_at: string | null
    }
    expect(row.archived_at !== null).toBe(true)
  })

  test('tasks delete <prefix> still echoes id + title', async () => {
    const id = seed('PrefixDelete')
    const r = await runCli(['tasks', 'delete', id.slice(0, 8)], noDbEnv)
    expect(r.exitCode).toBe(0)
    expect(r.stdout.includes(`Deleted: ${id.slice(0, 8)}  PrefixDelete`)).toBe(true)
    const row = db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(id) as {
      deleted_at: string | null
    }
    expect(row.deleted_at !== null).toBe(true)
  })

  test('tasks open <prefix> broadcasts the FULL id', async () => {
    resetOpenSpies()
    const id = seed('PrefixOpen')
    const r = await runCli(['tasks', 'open', id.slice(0, 8)], noDbEnv)
    expect(r.exitCode).toBe(0)
    expect(openTaskBroadcasts.length).toBe(1)
    expect(openTaskBroadcasts[0].taskId).toBe(id)
  })

  test('ambiguous prefix exits 1 and lists the candidates', async () => {
    const a = seed('Amb A', `77777777-aaaa-${crypto.randomUUID().slice(14)}`)
    const b = seed('Amb B', `77777777-cccc-${crypto.randomUUID().slice(14)}`)
    const r = await runCli(['tasks', 'archive', '77777777'], noDbEnv)
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Ambiguous id prefix "77777777"')).toBe(true)
    expect(r.stderr.includes(a.slice(0, 8))).toBe(true)
    expect(r.stderr.includes(b.slice(0, 8))).toBe(true)
  })

  test('unknown prefix exits 1 naming what was searched for', async () => {
    const r = await runCli(['tasks', 'archive', 'deadbeef'], noDbEnv)
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Task not found: deadbeef')).toBe(true)
  })

  test('cleanup', () => {
    fs.rmSync(noDbRoot, { recursive: true, force: true })
    expect(true).toBe(true)
  })
})

/**
 * `slay tasks create` against a hub, with NO local database.
 *
 * It was the last command that could not: `openDb()` ran unconditionally on the
 * first line, so a remote hub died on "Database not found" before a flag was even
 * read. Project ref, status alias, template ref and the external-id dedupe all
 * moved into POST /api/tasks; the external id is now written BY the insert rather
 * than by a follow-up UPDATE behind the hub's back.
 */
await describe('CLI tasks create works without a local database', () => {
  const noDbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-no-db-create-'))
  const noDbEnv = { SLAYZONE_ROOT: noDbRoot }

  const tplId = crypto.randomUUID()
  db.prepare(
    `INSERT INTO task_templates (id, project_id, name, terminal_mode, default_status, default_priority)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(tplId, projectId, 'Hotfix', 'codex', 'in_progress', 2)

  test('sanity: this root really has no database file', () => {
    expect(fs.existsSync(path.join(storageDirFor(noDbRoot), getDbName(false)))).toBe(false)
  })

  test('creates a task and prints the Created line with the project name', async () => {
    const r = await runCli(['tasks', 'create', 'NoDbCreate', '--project', 'CLIREST'], noDbEnv)
    expect(r.exitCode).toBe(0)
    const row = db.prepare('SELECT id, status FROM tasks WHERE title = ?').get('NoDbCreate') as {
      id: string
      status: string
    }
    expect(row).toBeTruthy()
    expect(r.stdout.trim()).toBe(
      `Created: ${row.id.slice(0, 8)}  NoDbCreate  [${row.status}]  CLIREST`
    )
  })

  test('--project matches a case-insensitive name substring', async () => {
    const r = await runCli(['tasks', 'create', 'NoDbSubstring', '--project', 'clire'], noDbEnv)
    expect(r.exitCode).toBe(0)
    const row = db.prepare('SELECT project_id FROM tasks WHERE title = ?').get('NoDbSubstring') as {
      project_id: string
    }
    expect(row.project_id).toBe(projectId)
  })

  test('--description --priority --due all forwarded', async () => {
    const r = await runCli(
      [
        'tasks',
        'create',
        'NoDbFull',
        '--project',
        'CLIREST',
        '--description',
        'the body',
        '--priority',
        '1',
        '--due',
        '2030-01-01'
      ],
      noDbEnv
    )
    expect(r.exitCode).toBe(0)
    const row = db
      .prepare('SELECT description, priority, due_date FROM tasks WHERE title = ?')
      .get('NoDbFull') as { description: string; priority: number; due_date: string }
    expect(row.description).toBe('the body')
    expect(row.priority).toBe(1)
    expect(row.due_date).toBe('2030-01-01')
  })

  test('--status accepts a label alias (resolved by the hub)', async () => {
    const r = await runCli(
      ['tasks', 'create', 'NoDbStatus', '--project', 'CLIREST', '--status', 'In Progress'],
      noDbEnv
    )
    expect(r.exitCode).toBe(0)
    const row = db.prepare('SELECT status FROM tasks WHERE title = ?').get('NoDbStatus') as {
      status: string
    }
    expect(row.status).toBe('in_progress')
    expect(r.stdout.includes('[in_progress]')).toBe(true)
  })

  test('--status unknown exits 1 with the exact CLI wording', async () => {
    const r = await runCli(
      ['tasks', 'create', 'NoDbBadStatus', '--project', 'CLIREST', '--status', 'nonsense'],
      noDbEnv
    )
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Unknown status "nonsense" for project "CLIREST".')).toBe(true)
    const row = db.prepare('SELECT id FROM tasks WHERE title = ?').get('NoDbBadStatus')
    expect(row).toBe(undefined)
  })

  test('--priority out of range exits 1 with the exact CLI wording', async () => {
    const r = await runCli(
      ['tasks', 'create', 'NoDbBadPrio', '--project', 'CLIREST', '--priority', '9'],
      noDbEnv
    )
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Priority must be 1-5.')).toBe(true)
  })

  test('--template by NAME applies the template defaults', async () => {
    const r = await runCli(
      ['tasks', 'create', 'NoDbTpl', '--project', 'CLIREST', '--template', 'Hotfix'],
      noDbEnv
    )
    expect(r.exitCode).toBe(0)
    const row = db
      .prepare('SELECT status, priority, terminal_mode FROM tasks WHERE title = ?')
      .get('NoDbTpl') as { status: string; priority: number; terminal_mode: string }
    expect(row.status).toBe('in_progress')
    expect(row.priority).toBe(2)
    expect(row.terminal_mode).toBe('codex')
  })

  test('--template by id PREFIX applies the same template', async () => {
    const r = await runCli(
      ['tasks', 'create', 'NoDbTplPrefix', '--project', 'CLIREST', '--template', tplId.slice(0, 8)],
      noDbEnv
    )
    expect(r.exitCode).toBe(0)
    const row = db.prepare('SELECT priority FROM tasks WHERE title = ?').get('NoDbTplPrefix') as {
      priority: number
    }
    expect(row.priority).toBe(2)
  })

  test('--template unknown exits 1 with the exact CLI wording', async () => {
    const r = await runCli(
      ['tasks', 'create', 'NoDbNoTpl', '--project', 'CLIREST', '--template', 'no-such-template'],
      noDbEnv
    )
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Template not found: "no-such-template"')).toBe(true)
  })

  test('--external-id lands on the created row (no post-create UPDATE)', async () => {
    const r = await runCli(
      [
        'tasks',
        'create',
        'NoDbExt',
        '--project',
        'CLIREST',
        '--external-id',
        'GH-42',
        '--external-provider',
        'github'
      ],
      noDbEnv
    )
    expect(r.exitCode).toBe(0)
    expect(r.stdout.startsWith('Created:')).toBe(true)
    const row = db
      .prepare('SELECT external_id, external_provider FROM tasks WHERE title = ?')
      .get('NoDbExt') as { external_id: string; external_provider: string }
    expect(row.external_id).toBe('GH-42')
    expect(row.external_provider).toBe('github')
  })

  test('re-running the same --external-id prints Exists and creates nothing', async () => {
    const existing = db
      .prepare('SELECT id, status FROM tasks WHERE external_id = ?')
      .get('GH-42') as { id: string; status: string }
    const r = await runCli(
      [
        'tasks',
        'create',
        'A DIFFERENT TITLE',
        '--project',
        'CLIREST',
        '--external-id',
        'GH-42',
        '--external-provider',
        'github'
      ],
      noDbEnv
    )
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(
      `Exists: ${existing.id.slice(0, 8)}  NoDbExt  [${existing.status}]  CLIREST`
    )
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE external_id = 'GH-42'`)
      .get() as { n: number }
    expect(count.n).toBe(1)
    expect(db.prepare('SELECT id FROM tasks WHERE title = ?').get('A DIFFERENT TITLE')).toBe(
      undefined
    )
  })

  test('unknown --project exits 1 with the CLI wording', async () => {
    const r = await runCli(
      ['tasks', 'create', 'NoDbNoProj', '--project', 'totally-not-a-project'],
      noDbEnv
    )
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('No project matching "totally-not-a-project"')).toBe(true)
  })

  test('no --project and no $SLAYZONE_PROJECT_ID exits 1 before any network call', async () => {
    const r = await runCli(['tasks', 'create', 'NoDbNoArg'], {
      ...noDbEnv,
      SLAYZONE_PROJECT_ID: undefined,
      SLAYZONE_HUB_ADDRESS: '127.0.0.1:1'
    })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('No --project provided and $SLAYZONE_PROJECT_ID is not set.')).toBe(
      true
    )
  })

  test('cleanup', () => {
    fs.rmSync(noDbRoot, { recursive: true, force: true })
    expect(true).toBe(true)
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
    // Reserved port 1 — connection refused immediately. An explicit
    // SLAYZONE_HUB_ADDRESS names a hub, so the failure reads as a hub connect
    // error (not the local-app one).
    const r = await runCli(['tasks', 'create', 'Lost', '--project', 'CLIREST'], {
      SLAYZONE_HUB_ADDRESS: '127.0.0.1:1'
    })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Could not connect to SlayZone hub')).toBe(true)
  })

  test('exits when no hub is configured and nothing hub-shaped answers the channel port', async () => {
    // `settings.server_port` is no longer part of this contract — the CLI reads no
    // database at all. With no SLAYZONE_HUB_ADDRESS and no hub-target file it
    // probes ONE fixed loopback port for its channel (SIDECAR_FIXED_PORT, keyed on
    // SLAYZONE_DEV) and requires a hub-shaped /health body.
    //
    // So the fixture has to OWN that port rather than hope it is free: a developer
    // box usually has a real sidecar on the dev port, and this case would then
    // quietly drive the live app instead of failing. `occupyFixedPort` binds a
    // listener that is emphatically NOT a hub on whichever channel port it can
    // claim, which makes the outcome deterministic AND puts the hub-shape
    // validation itself under test (a squatter must be rejected, not dialled).
    const decoy = await occupyFixedPort()
    let r: CliResult
    try {
      r = await runCli(['tasks', 'create', 'Lost2', '--project', 'CLIREST'], {
        SLAYZONE_HUB_ADDRESS: undefined,
        SLAYZONE_DEV: decoy.dev ? '1' : '0'
      })
    } finally {
      await decoy.close()
    }
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('server port not found')).toBe(true)
    // Nothing reached a real hub, so no row was created anywhere.
    expect(db.prepare('SELECT id FROM tasks WHERE title = ?').get('Lost2')).toBe(undefined)
  })
})

await rest.close()
db.close()
fs.rmSync(tmpDir, { recursive: true, force: true })
