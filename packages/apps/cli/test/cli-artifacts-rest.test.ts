/**
 * CLI artifact commands → REST integration tests (wave-3.5 sqlite-bypass).
 *
 * Spawns the bundled CLI (dist/slay.js) as a subprocess against an in-process
 * Express+REST stack on an ephemeral port (same pattern as cli-read-rest.test.ts).
 * Proves the converted artifact commands hit the REST surface — the CLI resolves
 * the hub from SLAYZONE_HUB_ADDRESS and routes through OUR registered handlers,
 * so no direct sqlite read/write remains on these paths:
 *   list     → GET    /api/tasks/:id/artifacts
 *   mkdir    → POST   /api/artifact-folders
 *   rmdir    → DELETE /api/artifact-folders/:id
 *   mvdir    → PATCH  /api/artifact-folders/:id
 *   mv       → PATCH  /api/artifacts/:id
 *   read     → GET    /api/artifacts/:id/content
 *   create   → POST   /api/artifacts?taskId&title[&folderId&renderMode]  (streamed body)
 *   upload   → POST   /api/tasks/:id/artifacts?title=                    (streamed body)
 *   delete   → DELETE /api/artifacts/:id
 *   download → GET    /api/artifacts/:id/content  (raw + zip)
 *              POST   /api/artifacts/:id/export/{pdf,png,html}
 *
 * The `CLI artifact commands work without a local database` suite below is the
 * regression guard: it runs with SLAYZONE_ROOT pointed at an EMPTY dir, which is
 * the whole point of the cutover — these commands used to `openDb()` the hub's
 * SQLite file and die on "Database not found" against a hub on another machine.
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
import { DB_PRAGMAS, getDbName, getStorageDir } from '../../../shared/platform/src/index.js'
import { registerRestApi } from '../../../shared/transport/src/server/http/rest-api/index.js'

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

const SLAY_BIN = path.resolve(import.meta.dirname, '../dist/slay.js')
if (!fs.existsSync(SLAY_BIN)) {
  console.error(`SKIP: dist/slay.js not built. Run \`pnpm --filter @slayzone/cli build\` first.`)
  process.exit(0)
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-cli-artifacts-'))
// The REST artifact store roots its on-disk files at the process's storage dir —
// anchor ROOT at the throwaway dir and let the resolver say where that lands.
process.env.SLAYZONE_ROOT = tmpDir
const storageDir = getStorageDir()
fs.mkdirSync(storageDir, { recursive: true })
// Dev filename: the CLI subprocesses below run with SLAYZONE_DEV=1.
const dbPath = path.join(storageDir, getDbName(false))
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
  /** Raw stdout bytes — `read`/`download` must be byte-exact for binary artifacts. */
  stdoutBytes: Buffer
  stderr: string
}
function runCli(
  args: string[],
  opts: { input?: string | Buffer; envOverrides?: Record<string, string | undefined> } = {}
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      SLAYZONE_ROOT: tmpDir,
      SLAYZONE_DEV: '1',
      SLAYZONE_HUB_ADDRESS: `127.0.0.1:${rest.port}`
    }
    for (const [k, v] of Object.entries(opts.envOverrides ?? {})) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const p = spawn('node', [SLAY_BIN, ...args], {
      env,
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe']
    })
    const outChunks: Buffer[] = []
    let stderr = ''
    p.stdout.on('data', (d: Buffer) => {
      outChunks.push(d)
    })
    p.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    if (opts.input !== undefined) {
      p.stdin!.write(opts.input)
      p.stdin!.end()
    }
    p.on('close', (code) => {
      const stdoutBytes = Buffer.concat(outChunks)
      resolve({ exitCode: code, stdout: stdoutBytes.toString('utf-8'), stdoutBytes, stderr })
    })
  })
}

const short = (id: string) => id.slice(0, 8)

// Shared across the suites below: `notes.md` (markdown) is the fixture the
// download-capability + no-server assertions address by prefix.
let artifactId = ''

await describe('CLI artifact metadata commands → REST', () => {
  let folderId = ''
  let childFolderId = ''

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

  test('create streams stdin through REST', async () => {
    const r = await runCli(
      ['tasks', 'artifacts', 'create', 'notes.md', '--task', short(taskId), '--json'],
      { input: '# hello' }
    )
    expect(r.exitCode).toBe(0)
    const artifact = JSON.parse(r.stdout) as { id: string; title: string }
    expect(artifact.title).toBe('notes.md')
    artifactId = artifact.id
    const row = db.prepare('SELECT title FROM task_artifacts WHERE id = ?').get(artifactId) as {
      title: string
    }
    expect(row.title).toBe('notes.md')
  })

  test('create exits 1 when REST is unreachable (no silent local write)', async () => {
    const r = await runCli(
      ['tasks', 'artifacts', 'create', 'orphan.md', '--task', short(taskId), '--json'],
      { input: 'x', envOverrides: { SLAYZONE_HUB_ADDRESS: '127.0.0.1:1' } }
    )
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Could not connect to SlayZone hub')).toBe(true)
    expect(
      db.prepare('SELECT 1 AS x FROM task_artifacts WHERE title = ?').get('orphan.md')
    ).toBeUndefined()
  })

  test('read streams content back through REST', async () => {
    const r = await runCli(['tasks', 'artifacts', 'read', short(artifactId)])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('# hello')
  })

  test('read on a row with NO working copy prints nothing and exits 0', async () => {
    // Long-standing behavior (the old `if (!fs.existsSync(fp)) return`). The route
    // 404s with code ARTIFACT_FILE_MISSING; the CLI must pass that through rather
    // than print an error — a version-only artifact is a normal state.
    const ghost = crypto.randomUUID()
    db.prepare(
      'INSERT INTO task_artifacts (id, task_id, title, "order") VALUES (?, ?, ?, ?)'
    ).run(ghost, taskId, 'ghost.md', 70)
    const r = await runCli(['tasks', 'artifacts', 'read', short(ghost)])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })

  test('download --type raw on a row with NO working copy is an ERROR (unlike read)', async () => {
    const ghost = crypto.randomUUID()
    db.prepare(
      'INSERT INTO task_artifacts (id, task_id, title, "order") VALUES (?, ?, ?, ?)'
    ).run(ghost, taskId, 'ghost2.md', 71)
    const r = await runCli([
      'tasks',
      'artifacts',
      'download',
      short(ghost),
      '--type',
      'raw',
      '--output',
      path.join(tmpDir, 'never.md')
    ])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Artifact file not found on disk.')).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'never.md'))).toBe(false)
  })

  test('list returns folders + artifacts via REST', async () => {
    const r = await runCli(['tasks', 'artifacts', 'list', short(taskId), '--json'])
    expect(r.exitCode).toBe(0)
    const out = JSON.parse(r.stdout) as {
      folders: { id: string }[]
      artifacts: { id: string }[]
    }
    expect(out.folders.map((f) => f.id).sort()).toEqual([folderId, childFolderId].sort())
    // Contains-not-equals: later suites seed more artifacts on this task, and the
    // point here is that the REST listing surfaces what the CLI created.
    expect(out.artifacts.map((a) => a.id)).toContain(artifactId)
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

  test('delete removes the artifact via REST and echoes id + title', async () => {
    const created = await runCli(
      ['tasks', 'artifacts', 'create', 'doomed.md', '--task', short(taskId), '--json'],
      { input: 'bye' }
    )
    const id = (JSON.parse(created.stdout) as { id: string }).id
    const r = await runCli(['tasks', 'artifacts', 'delete', short(id)])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(`Deleted: ${short(id)}  doomed.md`)
    expect(db.prepare('SELECT 1 AS x FROM task_artifacts WHERE id = ?').get(id)).toBeUndefined()
  })

  test('delete error: unknown artifact → exit 1 with the REST 404 message', async () => {
    const r = await runCli(['tasks', 'artifacts', 'delete', 'ffffffff'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Artifact not found: ffffffff')).toBe(true)
  })
})

/**
 * Binary safety. `read` writes raw bytes for a binary render mode (image/pdf) and
 * `download --type raw` copies the file; both now cross an HTTP hop, so a stray
 * utf-8 decode anywhere would replace every invalid sequence with U+FFFD. The
 * fixture below is deliberately NOT valid utf-8 (0xff 0xfe) and carries NULs +
 * CRLF, so any such hop shows up as a hex mismatch rather than passing silently.
 */
const BINARY = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x00, 0x01, 0x7f, 0x80
])

await describe('CLI artifact content is binary-safe end to end', () => {
  let pngId = ''

  test('upload sends a binary file byte-exact through REST', async () => {
    const srcPath = path.join(tmpDir, 'source.png')
    fs.writeFileSync(srcPath, BINARY)
    const r = await runCli([
      'tasks',
      'artifacts',
      'upload',
      srcPath,
      '--task',
      short(taskId),
      '--json'
    ])
    expect(r.exitCode).toBe(0)
    const artifact = JSON.parse(r.stdout) as { id: string; title: string }
    expect(artifact.title).toBe('source.png')
    pngId = artifact.id
    const onDisk = fs.readFileSync(
      path.join(storageDir, 'artifacts', taskId, `${pngId}.png`)
    )
    expect(onDisk.toString('hex')).toBe(BINARY.toString('hex'))
  })

  test('read emits the binary bytes to stdout unchanged', async () => {
    const r = await runCli(['tasks', 'artifacts', 'read', short(pngId)])
    expect(r.exitCode).toBe(0)
    expect(r.stdoutBytes.toString('hex')).toBe(BINARY.toString('hex'))
  })

  test('download --type raw writes the binary bytes unchanged', async () => {
    const out = path.join(tmpDir, 'downloaded.png')
    const r = await runCli([
      'tasks',
      'artifacts',
      'download',
      short(pngId),
      '--type',
      'raw',
      '--output',
      out
    ])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(out)
    expect(fs.readFileSync(out).toString('hex')).toBe(BINARY.toString('hex'))
  })

  test('create --copy-from streams a binary file byte-exact', async () => {
    const srcPath = path.join(tmpDir, 'copied.png')
    fs.writeFileSync(srcPath, BINARY)
    const r = await runCli(
      [
        'tasks',
        'artifacts',
        'create',
        'copied.png',
        '--task',
        short(taskId),
        '--copy-from',
        srcPath,
        '--json'
      ]
    )
    expect(r.exitCode).toBe(0)
    const artifact = JSON.parse(r.stdout) as { id: string }
    const onDisk = fs.readFileSync(
      path.join(storageDir, 'artifacts', taskId, `${artifact.id}.png`)
    )
    expect(onDisk.toString('hex')).toBe(BINARY.toString('hex'))
  })

  test('create --copy-from: missing file exits 1 before any REST call', async () => {
    const r = await runCli([
      'tasks',
      'artifacts',
      'create',
      'nope.md',
      '--task',
      short(taskId),
      '--copy-from',
      path.join(tmpDir, 'does-not-exist.md')
    ])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('File not found:')).toBe(true)
  })

  test('upload: missing source file exits 1 with the CLI wording', async () => {
    const r = await runCli([
      'tasks',
      'artifacts',
      'upload',
      path.join(tmpDir, 'ghost.bin'),
      '--task',
      short(taskId)
    ])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('File not found:')).toBe(true)
  })

  test('download --type zip bundles every artifact through REST', async () => {
    const out = path.join(tmpDir, 'bundle.zip')
    const r = await runCli([
      'tasks',
      'artifacts',
      'download',
      '--type',
      'zip',
      '--task',
      short(taskId),
      '--output',
      out
    ])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(out)
    expect(fs.existsSync(out)).toBe(true)
    // ZIP local-file-header magic — proves a real archive, not an error page.
    expect(fs.readFileSync(out).subarray(0, 4).toString('hex')).toBe('504b0304')
  })

  test('download --type pdf reports the host cannot export (no artifactExport dep)', async () => {
    // This harness registers the routes WITHOUT an `artifactExport` slot, i.e. the
    // standalone-hub shape → 501. The CLI must surface that, not crash.
    const r = await runCli(['tasks', 'artifacts', 'download', short(artifactId), '--type', 'pdf'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('not available in standalone server')).toBe(true)
  })

  test('download --type png on a markdown artifact is rejected client-side', async () => {
    // Capability check stays in the CLI (it knows the render mode from the row it
    // fetched), so the wording + the "available types" hint are unchanged.
    const r = await runCli(['tasks', 'artifacts', 'download', short(artifactId), '--type', 'png'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Cannot export "notes.md" (markdown) as png')).toBe(true)
    expect(r.stderr.includes('Available types for markdown: raw, pdf, html')).toBe(true)
  })

  test('download: artifactId required for non-zip types', async () => {
    const r = await runCli(['tasks', 'artifacts', 'download', '--type', 'raw'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Artifact ID required for --type raw')).toBe(true)
  })

  test('download: invalid type exits 1 listing the valid ones', async () => {
    const r = await runCli(['tasks', 'artifacts', 'download', short(artifactId), '--type', 'gif'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Invalid type "gif". Valid types: raw, pdf, png, html, zip')).toBe(
      true
    )
  })
})

await describe('CLI artifact create options route through REST', () => {
  test('--folder places the artifact in that folder', async () => {
    const mk = await runCli([
      'tasks',
      'artifacts',
      'mkdir',
      'Specs',
      '--task',
      short(taskId),
      '--json'
    ])
    const folderId = (JSON.parse(mk.stdout) as { id: string }).id
    const r = await runCli(
      [
        'tasks',
        'artifacts',
        'create',
        'spec.md',
        '--task',
        short(taskId),
        '--folder',
        short(folderId),
        '--json'
      ],
      { input: '# spec' }
    )
    expect(r.exitCode).toBe(0)
    const artifact = JSON.parse(r.stdout) as { id: string; folder_id: string | null }
    expect(artifact.folder_id).toBe(folderId)
    const row = db.prepare('SELECT folder_id FROM task_artifacts WHERE id = ?').get(artifact.id) as {
      folder_id: string
    }
    expect(row.folder_id).toBe(folderId)
  })

  test('--folder with an unknown id exits 1 with the REST 404 message', async () => {
    const r = await runCli(
      ['tasks', 'artifacts', 'create', 'nope.md', '--task', short(taskId), '--folder', 'ffffffff'],
      { input: 'x' }
    )
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Folder not found: ffffffff')).toBe(true)
  })

  test('--render-mode is persisted', async () => {
    const r = await runCli(
      [
        'tasks',
        'artifacts',
        'create',
        'diagram.txt',
        '--task',
        short(taskId),
        '--render-mode',
        'mermaid-preview',
        '--json'
      ],
      { input: 'graph TD;' }
    )
    expect(r.exitCode).toBe(0)
    const artifact = JSON.parse(r.stdout) as { id: string; render_mode: string | null }
    expect(artifact.render_mode).toBe('mermaid-preview')
    const row = db.prepare('SELECT render_mode FROM task_artifacts WHERE id = ?').get(
      artifact.id
    ) as { render_mode: string }
    expect(row.render_mode).toBe('mermaid-preview')
  })

  test('--title overrides the derived filename on upload', async () => {
    const srcPath = path.join(tmpDir, 'raw-name.bin')
    fs.writeFileSync(srcPath, Buffer.from('data'))
    const r = await runCli([
      'tasks',
      'artifacts',
      'upload',
      srcPath,
      '--task',
      short(taskId),
      '--title',
      'Nice Name.bin',
      '--json'
    ])
    expect(r.exitCode).toBe(0)
    expect((JSON.parse(r.stdout) as { title: string }).title).toBe('Nice Name.bin')
  })
})

/**
 * The regression guard for THIS slice: SLAYZONE_ROOT points at a directory with
 * no database file at all. Every command below used to `openDb()` the hub's
 * SQLite file to expand an id prefix / find the artifacts dir, so a hub on
 * another machine (where that file does not exist) died on openDb()'s
 * "Database not found" process.exit(1). The hub still has the DB; this CLI does not.
 */
await describe('CLI artifact commands work without a local database', () => {
  const noDbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-artifacts-no-db-'))
  const noDbEnv = { SLAYZONE_ROOT: noDbRoot }
  let remoteId = ''

  test('sanity: this root really has no database file', () => {
    expect(fs.existsSync(path.join(storageDirFor(noDbRoot), getDbName(false)))).toBe(false)
  })

  test('artifacts create <title> --task <prefix>', async () => {
    const r = await runCli(
      ['tasks', 'artifacts', 'create', 'remote.md', '--task', short(taskId), '--json'],
      { input: '# from afar', envOverrides: noDbEnv }
    )
    expect(r.exitCode).toBe(0)
    const artifact = JSON.parse(r.stdout) as { id: string; title: string }
    expect(artifact.title).toBe('remote.md')
    remoteId = artifact.id
    // Landed in the HUB's DB (this process's connection), never a local one.
    const row = db.prepare('SELECT title FROM task_artifacts WHERE id = ?').get(remoteId) as {
      title: string
    }
    expect(row.title).toBe('remote.md')
    // Nothing landed under the CLI's OWN root: the artifact tree only ever
    // appears on the hub. (The root dir itself exists — it is the mkdtemp above.)
    expect(fs.existsSync(path.join(storageDirFor(noDbRoot), 'artifacts'))).toBe(false)
  })

  test('artifacts read <prefix>', async () => {
    const r = await runCli(['tasks', 'artifacts', 'read', short(remoteId)], {
      envOverrides: noDbEnv
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('# from afar')
  })

  test('artifacts upload <path> --task <prefix>', async () => {
    const srcPath = path.join(noDbRoot, 'remote-upload.bin')
    fs.writeFileSync(srcPath, BINARY)
    const r = await runCli(
      ['tasks', 'artifacts', 'upload', srcPath, '--task', short(taskId), '--json'],
      { envOverrides: noDbEnv }
    )
    expect(r.exitCode).toBe(0)
    const artifact = JSON.parse(r.stdout) as { id: string; title: string }
    expect(artifact.title).toBe('remote-upload.bin')
    // Bytes crossed the wire and landed under the HUB's storage root.
    const onDisk = fs.readFileSync(
      path.join(storageDir, 'artifacts', taskId, `${artifact.id}.bin`)
    )
    expect(onDisk.toString('hex')).toBe(BINARY.toString('hex'))
  })

  test('artifacts download <prefix> --type raw', async () => {
    const out = path.join(noDbRoot, 'pulled.md')
    const r = await runCli(
      ['tasks', 'artifacts', 'download', short(remoteId), '--type', 'raw', '--output', out],
      { envOverrides: noDbEnv }
    )
    expect(r.exitCode).toBe(0)
    expect(fs.readFileSync(out, 'utf-8')).toBe('# from afar')
  })

  test('artifacts download --type zip --task <prefix>', async () => {
    const out = path.join(noDbRoot, 'pulled.zip')
    const r = await runCli(
      ['tasks', 'artifacts', 'download', '--type', 'zip', '--task', short(taskId), '--output', out],
      { envOverrides: noDbEnv }
    )
    expect(r.exitCode).toBe(0)
    expect(fs.readFileSync(out).subarray(0, 4).toString('hex')).toBe('504b0304')
  })

  test('artifacts list <prefix>', async () => {
    const r = await runCli(['tasks', 'artifacts', 'list', short(taskId), '--json'], {
      envOverrides: noDbEnv
    })
    expect(r.exitCode).toBe(0)
    const out = JSON.parse(r.stdout) as { artifacts: { id: string }[] }
    expect(out.artifacts.some((a) => a.id === remoteId)).toBe(true)
  })

  test('artifacts delete <prefix>', async () => {
    const r = await runCli(['tasks', 'artifacts', 'delete', short(remoteId)], {
      envOverrides: noDbEnv
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(`Deleted: ${short(remoteId)}  remote.md`)
    expect(
      db.prepare('SELECT 1 AS x FROM task_artifacts WHERE id = ?').get(remoteId)
    ).toBeUndefined()
  })

  test('ambiguous artifact prefix exits 1 and lists the candidates', async () => {
    const a = `4b4b4b4b-${crypto.randomUUID().slice(9)}`
    const b = `4b4b4b4b-${crypto.randomUUID().slice(9)}`
    const ins = db.prepare(
      'INSERT INTO task_artifacts (id, task_id, title, "order") VALUES (?, ?, ?, ?)'
    )
    ins.run(a, taskId, 'Amb A.md', 80)
    ins.run(b, taskId, 'Amb B.md', 81)
    const r = await runCli(['tasks', 'artifacts', 'delete', '4b4b4b4b'], { envOverrides: noDbEnv })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Ambiguous artifact id "4b4b4b4b"')).toBe(true)
    expect(r.stderr.includes(short(a))).toBe(true)
    expect(r.stderr.includes(short(b))).toBe(true)
  })

  test('unknown artifact prefix exits 1 naming what was searched for', async () => {
    const r = await runCli(['tasks', 'artifacts', 'read', 'deadbeef'], { envOverrides: noDbEnv })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Artifact not found: deadbeef')).toBe(true)
  })

  test('cleanup', () => {
    fs.rmSync(noDbRoot, { recursive: true, force: true })
    expect(true).toBe(true)
  })
})

await describe('CLI artifact metadata — no-server path', () => {
  test('mkdir exits 1 with helpful stderr when REST unreachable', async () => {
    const r = await runCli(['tasks', 'artifacts', 'mkdir', 'Nope', '--task', short(taskId)], {
      envOverrides: { SLAYZONE_HUB_ADDRESS: '127.0.0.1:1' }
    })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Could not connect to SlayZone hub')).toBe(true)
  })

  test('read exits 1 with helpful stderr when REST unreachable', async () => {
    const r = await runCli(['tasks', 'artifacts', 'read', short(artifactId)], {
      envOverrides: { SLAYZONE_HUB_ADDRESS: '127.0.0.1:1' }
    })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Could not connect to SlayZone hub')).toBe(true)
  })
})

await rest.close()
db.close()
fs.rmSync(tmpDir, { recursive: true, force: true })
