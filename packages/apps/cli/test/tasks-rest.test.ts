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
import { spawn } from 'node:child_process'
import express from 'express'
import Database from 'better-sqlite3'
import { test, expect, describe } from '../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../shared/test-utils/rest-harness.js'
import { spyTaskEvents } from '../../../shared/test-utils/event-spy.js'
import { __ipcEmitCalls, __resetIpcEmitCalls } from '../../../shared/test-utils/mock-electron.js'
import { DB_PRAGMAS } from '../../../shared/platform/src/index.js'
import { taskEvents } from '../../../domains/task/src/main/events.js'
import { registerCreateTaskRoute } from '../../app/src/main/rest-api/tasks/create.js'
import { registerUpdateTaskRoute } from '../../app/src/main/rest-api/tasks/update.js'
import { registerArchiveTaskRoute } from '../../app/src/main/rest-api/tasks/archive.js'
import { registerDeleteTaskRoute } from '../../app/src/main/rest-api/tasks/delete.js'
import { registerUnarchiveTaskRoute } from '../../app/src/main/rest-api/tasks/unarchive.js'

const SLAY_BIN = path.resolve(import.meta.dirname, '../dist/slay.js')
if (!fs.existsSync(SLAY_BIN)) {
  console.error(`SKIP: dist/slay.js not built. Run \`pnpm --filter @slayzone/cli build\` first.`)
  process.exit(0)
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-rest-test-'))
const dbPath = path.join(tmpDir, 'slayzone.dev.sqlite')

const db = new Database(dbPath)
for (const pragma of DB_PRAGMAS) db.pragma(pragma)
const migrationsPath = path.resolve(import.meta.dirname, '../../../apps/app/src/main/db/migrations.ts')
const mod = await import(migrationsPath)
mod.runMigrations(db)

const projectId = crypto.randomUUID()
db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'CLIREST', '#000', tmpDir)

let notifyCount = 0
const app = express()
app.use(express.json())
registerCreateTaskRoute(app, { db, notifyRenderer: () => { notifyCount++ } })
registerUpdateTaskRoute(app, { db, notifyRenderer: () => { notifyCount++ } })
registerArchiveTaskRoute(app, { db, notifyRenderer: () => { notifyCount++ } })
registerDeleteTaskRoute(app, { db, notifyRenderer: () => { notifyCount++ } })
registerUnarchiveTaskRoute(app, { db, notifyRenderer: () => { notifyCount++ } })
const rest = await mountRestApp(app)

interface CliResult { exitCode: number | null; stdout: string; stderr: string }

function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      SLAYZONE_DB_PATH: dbPath,
      SLAYZONE_DEV: '1',
      SLAYZONE_MCP_PORT: String(rest.port),
    }
    for (const [k, v] of Object.entries(envOverrides)) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const p = spawn('node', [SLAY_BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => { stdout += d.toString() })
    p.stderr.on('data', (d) => { stderr += d.toString() })
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
    const row = db.prepare('SELECT id, title FROM tasks WHERE title = ?').get('From CLI') as { id: string; title: string } | undefined
    expect(row?.title).toBe('From CLI')
    expect(spy.calls.length).toBe(1)
    const emits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:create:done')
    expect(emits.length).toBeGreaterThanOrEqual(1)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('happy: --description, --priority, --status forwarded through REST', async () => {
    const r = await runCli(['tasks', 'create', 'Detailed', '--project', 'CLIREST', '--description', 'desc text', '--priority', '1', '--status', 'todo'])
    expect(r.exitCode).toBe(0)
    const row = db.prepare('SELECT title, description, priority, status FROM tasks WHERE title = ?')
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
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, projectId, 'OrigTitle', 'todo', 3, 0)
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

await describe('CLI tasks archive → REST', () => {
  test('happy: POST /api/tasks/:id/archive; DB archived_at set; taskEvents fires', async () => {
    const id = crypto.randomUUID()
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, projectId, 'ToArchive', 'todo', 3, 0)
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:archived')
    const r = await runCli(['tasks', 'archive', id])
    spy.stop()
    expect(r.exitCode).toBe(0)
    const row = db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(id) as { archived_at: string | null }
    expect(row.archived_at !== null).toBe(true)
    expect(spy.calls.length).toBe(1)
  })
})

await describe('CLI app-down path', () => {
  test('apiPost exits with helpful stderr when REST unreachable', async () => {
    // Reserved port 1 — connection refused immediately
    const r = await runCli(['tasks', 'create', 'Lost', '--project', 'CLIREST'], { SLAYZONE_MCP_PORT: '1' })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('not running') || r.stderr.includes('could not connect')).toBe(true)
  })

  test('exits when no MCP port configured at all (env unset, settings empty)', async () => {
    db.prepare("DELETE FROM settings WHERE key = 'mcp_server_port'").run()
    const r = await runCli(['tasks', 'create', 'Lost2', '--project', 'CLIREST'], { SLAYZONE_MCP_PORT: undefined })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('MCP port not found')).toBe(true)
  })
})

await rest.close()
db.close()
fs.rmSync(tmpDir, { recursive: true, force: true })
