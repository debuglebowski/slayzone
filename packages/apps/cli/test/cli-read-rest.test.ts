/**
 * CLI read/domain commands → REST integration tests (wave-3 sqlite-bypass).
 *
 * Spawns the bundled CLI (dist/slay.js) as a subprocess against an in-process
 * Express+REST stack on an ephemeral port (same pattern as tasks-rest.test.ts).
 * Proves the converted commands (list/view/search/subtasks/blocking/blockers/
 * blocked/tag/progress; tags/projects/templates/panels/automations) hit the REST
 * surface — the CLI resolves the port from SLAYZONE_MCP_PORT and routes through
 * OUR registered handlers, so no direct sqlite read remains on these paths.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/apps/cli/test/cli-read-rest.test.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawn } from 'node:child_process'
import express from 'express'
import Database from 'better-sqlite3'
import { test, expect, describe, createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../shared/test-utils/rest-harness.js'
import { DB_PRAGMAS } from '../../../shared/platform/src/index.js'
import { registerRestApi } from '../../../shared/transport/src/server/http/rest-api/index.js'

const SLAY_BIN = path.resolve(import.meta.dirname, '../dist/slay.js')
if (!fs.existsSync(SLAY_BIN)) {
  console.error(`SKIP: dist/slay.js not built. Run \`pnpm --filter @slayzone/cli build\` first.`)
  process.exit(0)
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-cli-read-'))
const dbPath = path.join(tmpDir, 'slayzone.dev.sqlite')
const db = new Database(dbPath)
for (const pragma of DB_PRAGMAS) db.pragma(pragma)
const migrationsPath = path.resolve(
  import.meta.dirname,
  '../../../shared/transport/src/db-bootstrap/migrations.ts'
)
const mod = await import(migrationsPath)
mod.runMigrations(db)
const slayDb = createSlayzoneDbAdapter(db)

// Seed a project + tasks + tag + dependency.
const projectId = crypto.randomUUID()
db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
  projectId,
  'CLIREAD',
  '#000',
  tmpDir
)
const taskA = crypto.randomUUID()
const taskB = crypto.randomUUID()
db.prepare(
  'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
).run(taskA, projectId, 'Alpha task', 'todo', 3, 0)
db.prepare(
  'INSERT INTO tasks (id, project_id, parent_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?, ?)'
).run(taskB, projectId, taskA, 'Beta subtask', 'todo', 3, 1)
const tagId = crypto.randomUUID()
db.prepare('INSERT INTO tags (id, project_id, name, color, text_color, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(
  tagId,
  projectId,
  'urgent',
  '#f00',
  '#fff',
  0
)

const app = express()
app.use(express.json())
registerRestApi(app, { db: slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)

interface CliResult {
  exitCode: number | null
  stdout: string
  stderr: string
}
function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}): Promise<CliResult> {
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

await describe('CLI read commands → REST', () => {
  test('tasks list --json returns the stable TaskJson contract', async () => {
    const r = await runCli(['tasks', 'list', '--project', 'CLIREAD', '--json'])
    expect(r.exitCode).toBe(0)
    const rows = JSON.parse(r.stdout) as { id: string; is_blocked: boolean; tags: string[] }[]
    expect(rows.some((t) => t.id === taskA)).toBe(true)
    // Contract fields present.
    expect(rows.every((t) => 'is_blocked' in t && 'tags' in t)).toBe(true)
  })

  test('tasks view prints the resolved task detail', async () => {
    const r = await runCli(['tasks', 'view', taskA.slice(0, 8)])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.includes(`ID:       ${taskA}`)).toBe(true)
    expect(r.stdout.includes('Title:    Alpha task')).toBe(true)
  })

  test('tasks search matches by title substring', async () => {
    const r = await runCli(['tasks', 'search', 'Alpha', '--json'])
    expect(r.exitCode).toBe(0)
    const rows = JSON.parse(r.stdout) as { id: string }[]
    expect(rows.some((t) => t.id === taskA)).toBe(true)
  })

  test('tasks subtasks lists children', async () => {
    const r = await runCli(['tasks', 'subtasks', taskA.slice(0, 8), '--json'])
    expect(r.exitCode).toBe(0)
    const rows = JSON.parse(r.stdout) as { id: string }[]
    expect(rows.map((t) => t.id)).toEqual([taskB])
  })

  test('tasks blocked --on sets the flag (write via REST)', async () => {
    const r = await runCli(['tasks', 'blocked', taskA.slice(0, 8), '--on'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.includes('Blocked: yes')).toBe(true)
    const row = db.prepare('SELECT is_blocked FROM tasks WHERE id = ?').get(taskA) as {
      is_blocked: number
    }
    expect(row.is_blocked).toBe(1)
  })

  test('tasks tag --add assigns a tag (write via REST)', async () => {
    const r = await runCli(['tasks', 'tag', taskA.slice(0, 8), '--add', 'urgent'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('urgent')
    const link = db
      .prepare('SELECT 1 AS x FROM task_tags WHERE task_id = ? AND tag_id = ?')
      .get(taskA, tagId)
    expect(Boolean(link)).toBe(true)
  })

  test('tasks blockers --add wires a dependency (write via REST)', async () => {
    const r = await runCli(['tasks', 'blockers', taskA.slice(0, 8), '--add', taskB.slice(0, 8)])
    expect(r.exitCode).toBe(0)
    const dep = db
      .prepare('SELECT 1 AS x FROM task_dependencies WHERE task_id = ? AND blocks_task_id = ?')
      .get(taskB, taskA)
    expect(Boolean(dep)).toBe(true)
  })

  test('tasks progress writes progress via REST', async () => {
    const r = await runCli(['tasks', 'progress', taskA.slice(0, 8), '42'])
    expect(r.exitCode).toBe(0)
    const row = db.prepare('SELECT progress FROM tasks WHERE id = ?').get(taskA) as {
      progress: number
    }
    expect(row.progress).toBe(42)
  })

  test('view error: unknown task → exit 1 with REST 404 message', async () => {
    const r = await runCli(['tasks', 'view', 'ffffffff'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Task not found')).toBe(true)
  })
})

await describe('CLI domain commands → REST', () => {
  test('tags list --json returns project tags', async () => {
    const r = await runCli(['tags', 'list', '--project', 'CLIREAD', '--json'])
    expect(r.exitCode).toBe(0)
    const rows = JSON.parse(r.stdout) as { id: string; name: string }[]
    expect(rows.some((t) => t.name === 'urgent')).toBe(true)
  })

  test('tags create then delete (writes via REST)', async () => {
    const create = await runCli(['tags', 'create', 'later', '--project', 'CLIREAD'])
    expect(create.exitCode).toBe(0)
    expect(create.stdout.startsWith('Created tag:')).toBe(true)
    const created = db.prepare("SELECT id FROM tags WHERE name = 'later'").get() as { id: string }
    const del = await runCli(['tags', 'delete', created.id.slice(0, 8)])
    expect(del.exitCode).toBe(0)
    expect(db.prepare('SELECT 1 AS x FROM tags WHERE id = ?').get(created.id)).toBeUndefined()
  })

  test('projects list --json includes the seeded project', async () => {
    const r = await runCli(['projects', 'list', '--json'])
    expect(r.exitCode).toBe(0)
    const rows = JSON.parse(r.stdout) as { id: string; name: string }[]
    expect(rows.some((p) => p.id === projectId)).toBe(true)
  })

  test('projects update renames via REST', async () => {
    const r = await runCli(['projects', 'update', 'CLIREAD', '--color', '#123456'])
    expect(r.exitCode).toBe(0)
    const row = db.prepare('SELECT color FROM projects WHERE id = ?').get(projectId) as {
      color: string
    }
    expect(row.color).toBe('#123456')
  })

  test('templates create + list via REST', async () => {
    const create = await runCli(['templates', 'create', 'Bug', '--project', 'CLIREAD'])
    expect(create.exitCode).toBe(0)
    const list = await runCli(['templates', 'list', '--project', 'CLIREAD', '--json'])
    const rows = JSON.parse(list.stdout) as { name: string }[]
    expect(rows.some((t) => t.name === 'Bug')).toBe(true)
  })

  test('panels create + enable + list via REST', async () => {
    const create = await runCli(['panels', 'create', 'Docs', 'docs.example.com'])
    expect(create.exitCode).toBe(0)
    const list = await runCli(['panels', 'list', '--json'])
    const rows = JSON.parse(list.stdout) as { id: string; name: string }[]
    const panel = rows.find((p) => p.name === 'Docs')!
    expect(Boolean(panel)).toBe(true)
    const enable = await runCli(['panels', 'enable', panel.id])
    expect(enable.exitCode).toBe(0)
    expect(enable.stdout.startsWith('Enabled panel:')).toBe(true)
  })

  test('automations create + toggle + runs via REST', async () => {
    const create = await runCli([
      'automations',
      'create',
      'OnDone',
      '--project',
      'CLIREAD',
      '--trigger',
      'task_status_change',
      '--trigger-to-status',
      'done',
      '--action-command',
      'echo hi'
    ])
    expect(create.exitCode).toBe(0)
    const row = db.prepare("SELECT id FROM automations WHERE name = 'OnDone'").get() as {
      id: string
    }
    const toggle = await runCli(['automations', 'toggle', row.id.slice(0, 8)])
    expect(toggle.exitCode).toBe(0)
    expect(toggle.stdout.startsWith('Disabled:')).toBe(true)
    const runs = await runCli(['automations', 'runs', row.id.slice(0, 8), '--json'])
    expect(runs.exitCode).toBe(0)
    expect(Array.isArray(JSON.parse(runs.stdout))).toBe(true)
  })
})

await describe('CLI no-server path', () => {
  test('read command exits 1 with helpful stderr when REST unreachable', async () => {
    const r = await runCli(['tasks', 'list', '--project', 'CLIREAD'], { SLAYZONE_MCP_PORT: '1' })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('not running') || r.stderr.includes('could not connect')).toBe(true)
  })
})

await rest.close()
db.close()
fs.rmSync(tmpDir, { recursive: true, force: true })
