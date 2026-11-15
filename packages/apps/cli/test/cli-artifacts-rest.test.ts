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
 *   download → GET    /api/artifacts/:id/content  (raw + zip, and the source of the
 *                     pdf/png/html exports, which the CLI renders itself)
 *
 * The `CLI artifact commands work without a local database` suite below is the
 * regression guard: it runs with SLAYZONE_ROOT pointed at an EMPTY dir, which is
 * the whole point of the cutover — these commands used to `openDb()` the hub's
 * SQLite file and die on "Database not found" against a hub on another machine.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/cli/test/cli-artifacts-rest.test.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import express from 'express'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, test } from 'vitest'
import { createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../shared/test-utils/rest-harness.js'
import { DB_PRAGMAS, getDbName, getStorageDir } from '../../../shared/platform/src/index.js'
import { registerRestApi } from '../../../apps/api/src/http/rest-api/index.js'
import { defaultBrowserEnv, findBrowser } from '../src/export/browser.js'

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

// A Chrome-family browser the CLI's own discovery finds here (pdf/png render tests).
const LOCAL_BROWSER = findBrowser(defaultBrowserEnv())

const SLAY_BIN = path.resolve(import.meta.dirname, '../dist/slay.js')
// Without the bundle there is nothing to spawn: every suite below is skipped (the old
// runner's `process.exit(0)` SKIP, kept). CI builds the CLI before the unit tests.
const HAS_SLAY_BIN = fs.existsSync(SLAY_BIN)
if (!HAS_SLAY_BIN) {
  console.error(`SKIP: dist/slay.js not built. Run \`pnpm --filter @slayzone/cli build\` first.`)
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
  '../../../shared/db-migrations/src/migrations.ts'
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
// Every artifact-content fetch, by artifact id (the zip tests check what was fetched).
const contentFetches: string[] = []
app.use((req, _res, next) => {
  const m = /^\/api\/artifacts\/([^/]+)\/content$/.exec(req.path)
  if (req.method === 'GET' && m) contentFetches.push(decodeURIComponent(m[1]))
  next()
})
app.use(express.json())
registerRestApi(app, { db: slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)

interface CliResult {
  exitCode: number | null
  stdout: string
  /** Raw stdout bytes — `read`/`download` must be byte-exact for binary artifacts. */
  stdoutBytes: Buffer
  stderr: string
  /** Still running after `timeoutMs`: killed. */
  timedOut: boolean
}
function runCli(
  args: string[],
  opts: {
    input?: string | Buffer
    envOverrides?: Record<string, string | undefined>
    cwd?: string
    /** `ulimit -f` (KiB) for the CLI: a write past it fails with EFBIG. */
    fileSizeLimitKb?: number
    /** Kill the CLI after this long (a hang is reported as `timedOut`). */
    timeoutMs?: number
    /** The CLI's stdout is this open fd (a file, as `> file` / `>> file` would give). */
    stdoutFd?: number
  } = {}
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
    const [cmd, cmdArgs] =
      opts.fileSizeLimitKb === undefined
        ? ['node', [SLAY_BIN, ...args]]
        : [
            'sh',
            ['-c', `ulimit -f ${opts.fileSizeLimitKb}; exec node "$@"`, 'sh', SLAY_BIN, ...args]
          ]
    const p = spawn(cmd, cmdArgs, {
      env,
      cwd: opts.cwd,
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', opts.stdoutFd ?? 'pipe', 'pipe']
    })
    let timedOut = false
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            p.kill('SIGKILL')
          }, opts.timeoutMs)
    const outChunks: Buffer[] = []
    let stderr = ''
    p.stdout?.on('data', (d: Buffer) => {
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
      clearTimeout(timer)
      const stdoutBytes = Buffer.concat(outChunks)
      resolve({
        exitCode: code,
        stdout: stdoutBytes.toString('utf-8'),
        stdoutBytes,
        stderr,
        timedOut
      })
    })
  })
}

const short = (id: string) => id.slice(0, 8)

/** The entry names of a zip, from its central directory. */
function zipEntryNames(zip: Buffer): string[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  let at = zip.readUInt32LE(eocd + 16)
  const names: string[] = []
  for (let i = 0; i < zip.readUInt16LE(eocd + 10); i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50)
    const nameLen = zip.readUInt16LE(at + 28)
    const extraLen = zip.readUInt16LE(at + 30)
    const commentLen = zip.readUInt16LE(at + 32)
    names.push(zip.subarray(at + 46, at + 46 + nameLen).toString('utf8'))
    at += 46 + nameLen + extraLen + commentLen
  }
  return names
}

// Shared across the suites below: `notes.md` (markdown) is the fixture the
// download-capability + no-server assertions address by prefix.
let artifactId = ''

describe.skipIf(!HAS_SLAY_BIN)('CLI artifact metadata commands → REST', () => {
  let folderId = ''
  let childFolderId = ''

  test('mkdir creates a root folder via REST', async () => {
    const r = await runCli([
      'tasks',
      'artifacts',
      'mkdir',
      'Docs',
      '--task',
      short(taskId),
      '--json'
    ])
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
    db.prepare('INSERT INTO task_artifacts (id, task_id, title, "order") VALUES (?, ?, ?, ?)').run(
      ghost,
      taskId,
      'ghost.md',
      70
    )
    const r = await runCli(['tasks', 'artifacts', 'read', short(ghost)])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })

  test('download --type raw on a row with NO working copy is an ERROR (unlike read)', async () => {
    const ghost = crypto.randomUUID()
    db.prepare('INSERT INTO task_artifacts (id, task_id, title, "order") VALUES (?, ?, ?, ?)').run(
      ghost,
      taskId,
      'ghost2.md',
      71
    )
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
    const row = db
      .prepare('SELECT parent_id FROM artifact_folders WHERE id = ?')
      .get(childFolderId) as { parent_id: string }
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
    expect(
      db.prepare('SELECT 1 AS x FROM artifact_folders WHERE id = ?').get(childFolderId)
    ).toBeUndefined()
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

describe.skipIf(!HAS_SLAY_BIN)('CLI artifact content is binary-safe end to end', () => {
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
    const onDisk = fs.readFileSync(path.join(storageDir, 'artifacts', taskId, `${pngId}.png`))
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

  // Review 7, #6: `--output` naming stdout writes into it as it stands — never a temp
  // file beside it (there is no such directory) renamed over it: a redirect target
  // keeps what it had (`>>`), a pipe gets the bytes, and the path line follows them.
  // …and a symlink of the person's own that leads there.
  const stdoutLink = path.join(tmpDir, 'to-stdout')
  if (process.platform !== 'win32') fs.symlinkSync('/dev/stdout', stdoutLink)
  const stdoutPaths =
    process.platform === 'win32'
      ? []
      : [
          '/dev/stdout',
          '/dev/fd/1',
          ...(process.platform === 'linux' ? ['/proc/self/fd/1'] : []),
          stdoutLink
        ]
  for (const target of stdoutPaths) {
    for (const mode of ['w', 'a'] as const) {
      test(`download --output ${target} with stdout ${mode === 'a' ? 'appended' : 'redirected'} to a file`, async () => {
        const file = path.join(tmpDir, `stdout-${mode}-${target.replaceAll('/', '_')}.out`)
        fs.writeFileSync(file, mode === 'a' ? 'previous\n' : '')
        const fd = fs.openSync(file, mode)
        let r: CliResult
        try {
          r = await runCli(
            ['tasks', 'artifacts', 'download', short(pngId), '--type', 'raw', '--output', target],
            { stdoutFd: fd }
          )
        } finally {
          fs.closeSync(fd)
        }
        expect(r.exitCode, r.stderr).toBe(0)
        const expected = Buffer.concat([
          Buffer.from(mode === 'a' ? 'previous\n' : ''),
          BINARY,
          Buffer.from(`${target}\n`)
        ])
        expect(fs.readFileSync(file).toString('hex')).toBe(expected.toString('hex'))
      })
    }
    test(`download --output ${target} with stdout a pipe`, async () => {
      const r = await runCli([
        'tasks',
        'artifacts',
        'download',
        short(pngId),
        '--type',
        'raw',
        '--output',
        target
      ])
      expect(r.exitCode, r.stderr).toBe(0)
      expect(r.stdoutBytes.toString('hex')).toBe(
        Buffer.concat([BINARY, Buffer.from(`${target}\n`)]).toString('hex')
      )
    })
  }

  test('create --copy-from streams a binary file byte-exact', async () => {
    const srcPath = path.join(tmpDir, 'copied.png')
    fs.writeFileSync(srcPath, BINARY)
    const r = await runCli([
      'tasks',
      'artifacts',
      'create',
      'copied.png',
      '--task',
      short(taskId),
      '--copy-from',
      srcPath,
      '--json'
    ])
    expect(r.exitCode).toBe(0)
    const artifact = JSON.parse(r.stdout) as { id: string }
    const onDisk = fs.readFileSync(path.join(storageDir, 'artifacts', taskId, `${artifact.id}.png`))
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

  // Review 5, #11: the zip's entry names come from the shared download planner, as on
  // desktop and web — titles are free text an agent picks.
  test('download --type zip: duplicate, climbing and backslash titles → unique, safe entries', async () => {
    const zipTask = crypto.randomUUID()
    db.prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
    ).run(zipTask, projectId, 'Zip names task', 'todo', 3, 1)
    const f = await runCli([
      'tasks',
      'artifacts',
      'mkdir',
      'docs',
      '--task',
      short(zipTask),
      '--json'
    ])
    expect(f.exitCode, f.stderr).toBe(0)
    const folder = (JSON.parse(f.stdout) as { id: string }).id
    for (const [title, inFolder] of [
      ['dup.md', false],
      ['dup.md', false],
      ['DUP.md', false],
      ['a/../../x.md', false],
      ['win\\name.md', false],
      ['C:evil.md', false],
      ['dup.md', true],
      ['../../../up.md', true]
    ] as const) {
      const c = await runCli(
        [
          'tasks',
          'artifacts',
          'create',
          title,
          '--task',
          short(zipTask),
          ...(inFolder ? ['--folder', folder] : []),
          '--json'
        ],
        { input: `# ${title}\n` }
      )
      expect(c.exitCode, c.stderr).toBe(0)
    }
    const out = path.join(tmpDir, 'names.zip')
    const r = await runCli([
      'tasks',
      'artifacts',
      'download',
      '--type',
      'zip',
      '--task',
      short(zipTask),
      '--output',
      out
    ])
    expect(r.exitCode, r.stderr).toBe(0)
    const names = zipEntryNames(fs.readFileSync(out))
    expect(names.sort()).toEqual(
      [
        'dup.md',
        'dup (2).md',
        'DUP (3).md',
        'a_x.md',
        'win_name.md',
        'C_evil.md',
        'docs/dup.md',
        'docs/up.md'
      ].sort()
    )
    for (const n of names) {
      expect(n.split('/')).not.toContain('..')
      expect(n).not.toMatch(/[\\:]/)
      expect(n.startsWith('/')).toBe(false)
    }
  })

  // Review 7, #4: the output fails partway (disk full, here a file-size limit). The
  // failure must end the command — non-zero, no output file, no temp file — and stop
  // fetching the remaining entries, not hang nor exit 0 with nothing written.
  test.skipIf(process.platform === 'win32')(
    'download --type zip whose output fails mid-stream exits non-zero and leaves nothing',
    async () => {
      const bigTask = crypto.randomUUID()
      db.prepare(
        'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
      ).run(bigTask, projectId, 'Zip output failure task', 'todo', 3, 2)
      const ids: string[] = []
      for (let i = 0; i < 6; i++) {
        // Random bytes: incompressible, so the archive outgrows the limit by entry 2.
        const src = path.join(tmpDir, `noise-${i}.bin`)
        fs.writeFileSync(src, randomBytes(150 * 1024))
        const u = await runCli([
          'tasks',
          'artifacts',
          'upload',
          src,
          '--task',
          short(bigTask),
          '--json'
        ])
        expect(u.exitCode, u.stderr).toBe(0)
        ids.push((JSON.parse(u.stdout) as { id: string }).id)
      }
      const dir = path.join(tmpDir, 'zip-output-fails')
      fs.mkdirSync(dir)
      const before = contentFetches.length
      const r = await runCli(
        [
          'tasks',
          'artifacts',
          'download',
          '--type',
          'zip',
          '--task',
          short(bigTask),
          '--output',
          path.join(dir, 'out.zip')
        ],
        { fileSizeLimitKb: 200, timeoutMs: 120_000 }
      )
      expect(r.timedOut).toBe(false)
      expect(r.exitCode).not.toBe(0)
      expect(r.stderr).toMatch(/EFBIG|too large/i)
      expect(r.stdout).toBe('')
      expect(fs.readdirSync(dir)).toEqual([])
      // Fetching stopped at the failure: the last entries were never requested.
      const fetched = contentFetches.slice(before).filter((id) => ids.includes(id))
      expect(fetched.length).toBeGreaterThan(0)
      expect(fetched.length).toBeLessThan(ids.length)
    },
    180_000
  )

  // pdf/png/html are rendered BY THE CLI from the content route — this harness's hub
  // has no exporter at all (the standalone-hub shape), and the exports still work.
  test('download --type html renders locally, no browser involved', async () => {
    const out = path.join(tmpDir, 'notes-export.html')
    // An unusable --browser proves html never looks for one.
    const r = await runCli([
      'tasks',
      'artifacts',
      'download',
      short(artifactId),
      '--type',
      'html',
      '--output',
      out,
      '--browser',
      path.join(tmpDir, 'no-such-browser')
    ])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(out)
    const html = fs.readFileSync(out, 'utf8')
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<title>notes.md</title>')
    expect(html).toContain('<h1>hello</h1>')
  })

  // Review 1, L2: with no --output the file lands in the current directory under a
  // name made safe from the title — an agent-named artifact cannot point it elsewhere
  // (the hub's owned-path guard on the old export route no longer stands in front).
  test('download without --output: a title that climbs or is absolute stays in the cwd', async () => {
    const cwd = path.join(tmpDir, 'l2', 'a', 'b')
    fs.mkdirSync(cwd, { recursive: true })
    // Review 5, #12: a 300-byte title and a Windows drive-relative one also get a
    // name every filesystem accepts (≤255 bytes, extension kept; no `:`).
    const long = `${'x'.repeat(297)}.md`
    for (const [title, type, expected] of [
      ['../../escape-l2.md', 'html', 'escape-l2.html'],
      ['../../escape-raw.md', 'raw', 'escape-raw.md'],
      ['/abs/dir/abs-l2.md', 'html', 'abs_dir_abs-l2.html'],
      ['C:evil.md', 'raw', 'C_evil.md'],
      ['C:evil-h.md', 'html', 'C_evil-h.html'],
      [long, 'raw', `${'x'.repeat(252)}.md`],
      [long, 'html', `${'x'.repeat(250)}.html`],
      ['y'.repeat(300), 'html', `${'y'.repeat(250)}.html`]
    ] as const) {
      const c = await runCli(
        ['tasks', 'artifacts', 'create', title, '--task', short(taskId), '--json'],
        { input: '# x\n' }
      )
      expect(c.exitCode, c.stderr).toBe(0)
      const id = (JSON.parse(c.stdout) as { id: string }).id
      const r = await runCli(['tasks', 'artifacts', 'download', short(id), '--type', type], { cwd })
      expect(r.exitCode, r.stderr).toBe(0)
      expect(fs.realpathSync(r.stdout.trim())).toBe(fs.realpathSync(path.join(cwd, expected)))
    }
    expect(fs.existsSync(path.join(tmpDir, 'l2', 'escape-l2.html'))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, 'l2', 'escape-raw.md'))).toBe(false)
  })

  // Review 6, #5: with no --output the name comes from the title, so it may already be
  // taken in the cwd — by a file the person cares about, or a symlink to one. Neither
  // is overwritten (nor written through): the download is numbered `name (2).ext`.
  test('download without --output never overwrites an existing name in the cwd', async () => {
    const cwd = path.join(tmpDir, 'no-clobber')
    const outside = path.join(tmpDir, 'no-clobber-outside')
    fs.mkdirSync(cwd, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    const c = await runCli(
      ['tasks', 'artifacts', 'create', 'keep.md', '--task', short(taskId), '--json'],
      { input: '# fresh\n' }
    )
    expect(c.exitCode, c.stderr).toBe(0)
    const id = (JSON.parse(c.stdout) as { id: string }).id

    // keep.md: a precious regular file. keep.html: a symlink to a file elsewhere.
    // artifacts.zip: the zip's default name, also taken.
    fs.writeFileSync(path.join(cwd, 'keep.md'), 'precious md')
    fs.writeFileSync(path.join(outside, 'target.html'), 'precious html')
    fs.symlinkSync(path.join(outside, 'target.html'), path.join(cwd, 'keep.html'))
    fs.writeFileSync(path.join(cwd, 'artifacts.zip'), 'precious zip')

    const download = async (args: string[]) => {
      const r = await runCli(['tasks', 'artifacts', 'download', ...args], { cwd })
      expect(r.exitCode, r.stderr).toBe(0)
      return fs.realpathSync(r.stdout.trim())
    }
    const at = (name: string) => fs.realpathSync(path.join(cwd, name))

    expect(await download([short(id), '--type', 'raw'])).toBe(at('keep (2).md'))
    expect(fs.readFileSync(path.join(cwd, 'keep (2).md'), 'utf8')).toBe('# fresh\n')
    // Taken again (by our own previous download): the next number.
    expect(await download([short(id), '--type', 'raw'])).toBe(at('keep (3).md'))
    expect(await download([short(id), '--type', 'html'])).toBe(at('keep (2).html'))
    expect(fs.readFileSync(path.join(cwd, 'keep (2).html'), 'utf8')).toContain('<h1>fresh</h1>')
    expect(await download(['--type', 'zip', '--task', short(taskId)])).toBe(at('artifacts (2).zip'))
    expect(
      fs.readFileSync(path.join(cwd, 'artifacts (2).zip')).subarray(0, 4).toString('hex')
    ).toBe('504b0304')

    expect(fs.readFileSync(path.join(cwd, 'keep.md'), 'utf8')).toBe('precious md')
    expect(fs.lstatSync(path.join(cwd, 'keep.html')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(outside, 'target.html'), 'utf8')).toBe('precious html')
    expect(fs.readFileSync(path.join(cwd, 'artifacts.zip'), 'utf8')).toBe('precious zip')
    // Nothing else left behind (no temp files).
    expect(fs.readdirSync(cwd).sort()).toEqual(
      [
        'artifacts (2).zip',
        'artifacts.zip',
        'keep (2).html',
        'keep (2).md',
        'keep (3).md',
        'keep.html',
        'keep.md'
      ].sort()
    )
    expect(fs.readdirSync(outside)).toEqual(['target.html'])
  })

  // With --output the person chose the path: an existing file there is replaced, as
  // before — but whole, never left half-written.
  test('download --output replaces an existing file there, leaving no temp file', async () => {
    const dir = path.join(tmpDir, 'explicit-output')
    fs.mkdirSync(dir, { recursive: true })
    const out = path.join(dir, 'chosen.md')
    fs.writeFileSync(out, 'old content')
    const r = await runCli([
      'tasks',
      'artifacts',
      'download',
      short(artifactId),
      '--type',
      'raw',
      '--output',
      out
    ])
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe(out)
    expect(fs.readFileSync(out, 'utf8')).not.toBe('old content')
    expect(fs.readdirSync(dir)).toEqual(['chosen.md'])
  })

  test('download --type html of a mermaid artifact embeds the bundled mermaid build', async () => {
    const c = await runCli(
      ['tasks', 'artifacts', 'create', 'flow.mmd', '--task', short(taskId), '--json'],
      { input: 'graph TD\n  A --> B\n' }
    )
    expect(c.exitCode).toBe(0)
    const id = (JSON.parse(c.stdout) as { id: string }).id
    const out = path.join(tmpDir, 'flow-export.html')
    const r = await runCli([
      'tasks',
      'artifacts',
      'download',
      short(id),
      '--type',
      'html',
      '--output',
      out
    ])
    expect(r.exitCode).toBe(0)
    const html = fs.readFileSync(out, 'utf8')
    // The inlined (compressed) payload decoded to the real browser build, not the
    // code-block fallback a missing mermaid degrades to.
    expect(html).toContain('<pre class="mermaid">')
    expect(html).toContain('mermaid.initialize(')
    expect(html.length).toBeGreaterThan(1_000_000)
  })

  test('download --type pdf with a --browser that does not exist is refused', async () => {
    const r = await runCli([
      'tasks',
      'artifacts',
      'download',
      short(artifactId),
      '--type',
      'pdf',
      '--browser',
      path.join(tmpDir, 'no-such-browser')
    ])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Browser not found or not executable:')
  })

  test.skipIf(!LOCAL_BROWSER)(
    'download --type pdf renders in the local browser',
    { timeout: 60_000 },
    async () => {
      const out = path.join(tmpDir, 'notes-export.pdf')
      const r = await runCli([
        'tasks',
        'artifacts',
        'download',
        short(artifactId),
        '--type',
        'pdf',
        '--output',
        out
      ])
      expect(r.exitCode).toBe(0)
      expect(r.stdout.trim()).toBe(out)
      expect(fs.readFileSync(out).subarray(0, 5).toString('ascii')).toBe('%PDF-')
    }
  )

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

describe.skipIf(!HAS_SLAY_BIN)('CLI artifact create options route through REST', () => {
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
    const row = db
      .prepare('SELECT folder_id FROM task_artifacts WHERE id = ?')
      .get(artifact.id) as {
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
    const row = db
      .prepare('SELECT render_mode FROM task_artifacts WHERE id = ?')
      .get(artifact.id) as { render_mode: string }
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
describe.skipIf(!HAS_SLAY_BIN)('CLI artifact commands work without a local database', () => {
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
    const onDisk = fs.readFileSync(path.join(storageDir, 'artifacts', taskId, `${artifact.id}.bin`))
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

describe.skipIf(!HAS_SLAY_BIN)('CLI artifact metadata — no-server path', () => {
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

afterAll(async () => {
  await rest.close()
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
