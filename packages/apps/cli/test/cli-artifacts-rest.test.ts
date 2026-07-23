/**
 * CLI artifact metadata commands → REST integration tests (wave-3.5 sqlite-bypass).
 *
 * Spawns the bundled CLI (dist/slay.js) as a subprocess against an in-process
 * Express+REST stack on an ephemeral port (same pattern as cli-read-rest.test.ts).
 * Proves the METADATA-ONLY artifact commands hit the REST surface — the CLI
 * resolves the port from SLAYZONE_SERVER_PORT and routes through OUR registered
 * handlers, so no direct sqlite read/write remains on these paths:
 *   list  → GET    /api/tasks/:id/artifacts
 *   mkdir → POST   /api/artifact-folders
 *   rmdir → DELETE /api/artifact-folders/:id
 *   mvdir → PATCH  /api/artifact-folders/:id
 *   mv    → PATCH  /api/artifacts/:id
 *
 * It ALSO proves the disk-local commands (create/read) are unchanged: with the
 * REST server unreachable they still round-trip content through the on-disk DB +
 * blob store (direct sqlite), i.e. they never went through REST.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/apps/cli/test/cli-artifacts-rest.test.ts
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-cli-artifacts-'))
// The REST artifact store + the CLI's disk-local commands both root their on-disk
// files at <ROOT>/storage — anchor ROOT at the throwaway dir.
process.env.SLAYZONE_ROOT = tmpDir
const storageDir = path.join(tmpDir, 'storage')
fs.mkdirSync(storageDir, { recursive: true })
const dbPath = path.join(storageDir, 'slayzone.dev.sqlite')
const db = new Database(dbPath)
for (const pragma of DB_PRAGMAS) db.pragma(pragma)
const migrationsPath = path.resolve(
  import.meta.dirname,
  '../../../shared/transport/src/db-bootstrap/migrations.ts'
)
const mod = await import(migrationsPath)
mod.runMigrations(db)
const slayDb = createSlayzoneDbAdapter(db)

// Seed a project + task.
const projectId = crypto.randomUUID()
db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
  projectId,
  'ARTIFACTS',
  '#000',
  tmpDir
)
const taskId = crypto.randomUUID()
db.prepare(
  'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
).run(taskId, projectId, 'Artifact task', 'todo', 3, 0)

const app = express()
app.use(express.json())
registerRestApi(app, { db: slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)

interface CliResult {
  exitCode: number | null
  stdout: string
  stderr: string
}
function runCli(
  args: string[],
  opts: { input?: string; envOverrides?: Record<string, string | undefined> } = {}
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      SLAYZONE_DB_PATH: dbPath,
      SLAYZONE_ROOT: tmpDir,
      SLAYZONE_DEV: '1',
      SLAYZONE_SERVER_PORT: String(rest.port)
    }
    for (const [k, v] of Object.entries(opts.envOverrides ?? {})) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const p = spawn('node', [SLAY_BIN, ...args], {
      env,
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    p.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    if (opts.input !== undefined) {
      p.stdin!.write(opts.input)
      p.stdin!.end()
    }
    p.on('close', (code) => resolve({ exitCode: code, stdout, stderr }))
  })
}

const short = (id: string) => id.slice(0, 8)

await describe('CLI artifact metadata commands → REST', () => {
  let folderId = ''
  let childFolderId = ''
  let artifactId = ''

  test('mkdir creates a root folder via REST', async () => {
    const r = await runCli(['tasks', 'artifacts', 'mkdir', 'Docs', '--task', short(taskId), '--json'])
    expect(r.exitCode).toBe(0)
    const folder = JSON.parse(r.stdout) as { id: string; name: string; parent_id: string | null }
    expect(folder.name).toBe('Docs')
    expect(folder.parent_id).toBeNull()
    // Row landed through the REST server's DB (same file) — no client-side insert.
    const row = db.prepare('SELECT name FROM artifact_folders WHERE id = ?').get(folder.id) as {
      name: string
    }
    expect(row.name).toBe('Docs')
    folderId = folder.id
  })

  test('mkdir --parent creates a child folder via REST', async () => {
    const r = await runCli([
      'tasks',
      'artifacts',
      'mkdir',
      'Sub',
      '--task',
      short(taskId),
      '--parent',
      short(folderId),
      '--json'
    ])
    expect(r.exitCode).toBe(0)
    const folder = JSON.parse(r.stdout) as { id: string; parent_id: string | null }
    expect(folder.parent_id).toBe(folderId)
    childFolderId = folder.id
  })

  test('create (disk-local) still writes directly to the DB + blob store', async () => {
    // Disk-local path: uses openDb() + BlobStore, NOT REST. Prove it by pointing
    // SLAYZONE_SERVER_PORT at a dead port — a REST call would fail, this must not.
    const r = await runCli(['tasks', 'artifacts', 'create', 'notes.md', '--task', short(taskId), '--json'], {
      input: '# hello',
      envOverrides: { SLAYZONE_SERVER_PORT: '1' }
    })
    expect(r.exitCode).toBe(0)
    const artifact = JSON.parse(r.stdout) as { id: string; title: string }
    expect(artifact.title).toBe('notes.md')
    artifactId = artifact.id
    const row = db.prepare('SELECT title FROM task_artifacts WHERE id = ?').get(artifactId) as {
      title: string
    }
    expect(row.title).toBe('notes.md')
  })

  test('read (disk-local) round-trips content from disk (no REST)', async () => {
    const r = await runCli(['tasks', 'artifacts', 'read', short(artifactId)], {
      envOverrides: { SLAYZONE_SERVER_PORT: '1' }
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('# hello')
  })

  test('list returns folders + artifacts via REST', async () => {
    const r = await runCli(['tasks', 'artifacts', 'list', short(taskId), '--json'])
    expect(r.exitCode).toBe(0)
    const out = JSON.parse(r.stdout) as {
      folders: { id: string }[]
      artifacts: { id: string }[]
    }
    expect(out.folders.map((f) => f.id).sort()).toEqual([folderId, childFolderId].sort())
    expect(out.artifacts.map((a) => a.id)).toEqual([artifactId])
  })

  test('mv moves an artifact into a folder via REST (echoes folder name)', async () => {
    const r = await runCli([
      'tasks',
      'artifacts',
      'mv',
      short(artifactId),
      '--folder',
      short(childFolderId)
    ])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(`Moved: ${short(artifactId)} -> Sub`)
    const row = db.prepare('SELECT folder_id FROM task_artifacts WHERE id = ?').get(artifactId) as {
      folder_id: string
    }
    expect(row.folder_id).toBe(childFolderId)
  })

  test('mv --folder root clears the folder via REST', async () => {
    const r = await runCli(['tasks', 'artifacts', 'mv', short(artifactId), '--folder', 'root'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(`Moved: ${short(artifactId)} -> root`)
    const row = db.prepare('SELECT folder_id FROM task_artifacts WHERE id = ?').get(artifactId) as {
      folder_id: string | null
    }
    expect(row.folder_id).toBeNull()
  })

  test('mvdir moves a folder under a parent via REST (echoes parent name)', async () => {
    // childFolderId currently under folderId; move it to root, then back under Docs.
    const toRoot = await runCli([
      'tasks',
      'artifacts',
      'mvdir',
      short(childFolderId),
      '--parent',
      'root'
    ])
    expect(toRoot.exitCode).toBe(0)
    expect(toRoot.stdout.trim()).toBe(`Moved folder: ${short(childFolderId)} -> root`)

    const back = await runCli([
      'tasks',
      'artifacts',
      'mvdir',
      short(childFolderId),
      '--parent',
      short(folderId)
    ])
    expect(back.exitCode).toBe(0)
    expect(back.stdout.trim()).toBe(`Moved folder: ${short(childFolderId)} -> Docs`)
    const row = db.prepare('SELECT parent_id FROM artifact_folders WHERE id = ?').get(
      childFolderId
    ) as { parent_id: string }
    expect(row.parent_id).toBe(folderId)
  })

  test('mvdir cycle guard: cannot move a folder into its own descendant', async () => {
    const r = await runCli([
      'tasks',
      'artifacts',
      'mvdir',
      short(folderId),
      '--parent',
      short(childFolderId)
    ])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Cannot move folder into its own descendant')).toBe(true)
  })

  test('rmdir deletes a folder via REST (artifacts fall to root)', async () => {
    const r = await runCli(['tasks', 'artifacts', 'rmdir', short(childFolderId), '--json'])
    expect(r.exitCode).toBe(0)
    const out = JSON.parse(r.stdout) as { deleted: string; name: string }
    expect(out.deleted).toBe(childFolderId)
    expect(db.prepare('SELECT 1 AS x FROM artifact_folders WHERE id = ?').get(childFolderId)).toBeUndefined()
  })

  test('list error: unknown task → exit 1 with REST 404 message', async () => {
    const r = await runCli(['tasks', 'artifacts', 'list', 'ffffffff', '--json'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Task not found')).toBe(true)
  })
})

await describe('CLI artifact metadata — no-server path', () => {
  test('mkdir exits 1 with helpful stderr when REST unreachable', async () => {
    const r = await runCli(['tasks', 'artifacts', 'mkdir', 'Nope', '--task', short(taskId)], {
      envOverrides: { SLAYZONE_SERVER_PORT: '1' }
    })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('not running') || r.stderr.includes('could not connect')).toBe(true)
  })
})

await rest.close()
db.close()
fs.rmSync(tmpDir, { recursive: true, force: true })
