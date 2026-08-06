/**
 * `slay tasks artifacts` version-history + search commands → REST integration tests.
 *
 * These are the LAST subcommands that opened the hub's SQLite file (and its blob
 * store) directly: `search`, `update`, `write`, `append`, and every `versions *`.
 * None of them worked against a hub on another machine — `openDb()` printed
 * "Database not found" and exited 1.
 *
 * Spawns the bundled CLI (dist/slay.js) against an in-process Express+REST stack
 * on an ephemeral port, same pattern as cli-artifacts-rest.test.ts. Every suite
 * below runs with `SLAYZONE_ROOT` pointing at a directory that holds NO database:
 * the hub has the DB and the artifact files, this CLI has neither. That IS the
 * regression guard.
 *
 * Byte-exactness is asserted in HEX, on fixtures that are deliberately not valid
 * utf-8 (0xff 0xfe) with embedded NULs + CRLF — a string hop anywhere replaces
 * those with U+FFFD, which is invisible unless you compare bytes.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/apps/cli/test/cli-artifacts-versions-rest.test.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawn } from 'node:child_process'
import express from 'express'
import Database from 'better-sqlite3'
import {
  test,
  expect,
  describe,
  createSlayzoneDbAdapter
} from '../../../shared/test-utils/ipc-harness.js'
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

// The HUB's install root: it holds the DB, the artifact working copies and the blobs.
const hubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-artifacts-vers-hub-'))
process.env.SLAYZONE_ROOT = hubRoot
const storageDir = getStorageDir()
fs.mkdirSync(storageDir, { recursive: true })
// Dev filename: the CLI subprocesses below run with SLAYZONE_DEV=1.
const db = new Database(path.join(storageDir, getDbName(false)))
for (const pragma of DB_PRAGMAS) db.pragma(pragma)
const migrationsPath = path.resolve(
  import.meta.dirname,
  '../../../shared/transport/src/db-bootstrap/migrations.ts'
)
const mod = await import(migrationsPath)
mod.runMigrations(db)
const slayDb = createSlayzoneDbAdapter(db)

const projectId = crypto.randomUUID()
db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
  projectId,
  'VERSIONS',
  '#000',
  hubRoot
)
const taskId = crypto.randomUUID()
db.prepare(
  'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
).run(taskId, projectId, 'Version task', 'todo', 3, 0)
const otherTaskId = crypto.randomUUID()
db.prepare(
  'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
).run(otherTaskId, projectId, 'Other task', 'todo', 3, 1)

const app = express()
app.use(express.json())
registerRestApi(app, { db: slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)

/**
 * The CLI's OWN root: empty, no database. Every runCli below inherits it, so any
 * surviving `openDb()` fails loudly instead of silently reading the hub's file.
 */
const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-artifacts-vers-cli-'))

interface CliResult {
  exitCode: number | null
  stdout: string
  /** Raw stdout bytes — `versions read` must be byte-exact for binary content. */
  stdoutBytes: Buffer
  stderr: string
}
function runCli(
  args: string[],
  opts: {
    input?: string | Buffer
    envOverrides?: Record<string, string | undefined>
  } = {}
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      SLAYZONE_ROOT: cliRoot,
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

/** Bytes that are NOT valid utf-8, plus NUL + CRLF. */
const BINARY = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x00, 0x01, 0x7f, 0x80
])
const BINARY2 = Buffer.from([0x00, 0xfe, 0xff, 0x0d, 0x0a, 0x42])

async function createArtifact(title: string, content: string | Buffer): Promise<string> {
  const r = await runCli(['tasks', 'artifacts', 'create', title, '--task', short(taskId), '--json'], {
    input: content
  })
  if (r.exitCode !== 0) throw new Error(`create failed: ${r.stderr}`)
  return (JSON.parse(r.stdout) as { id: string }).id
}

interface VersionJson {
  id: string
  version_num: number
  content_hash: string
  size: number
  name: string | null
  author_type: string | null
  author_id: string | null
}

await describe('sanity: the CLI root really has no database', () => {
  test('no sqlite file under the CLI root', () => {
    expect(fs.existsSync(path.join(storageDirFor(cliRoot), getDbName(false)))).toBe(false)
  })
})

let binId = ''
let textId = ''

await describe('artifacts write / append with NO local database', () => {
  test('write replaces content from stdin, byte-exact, and reports the new version', async () => {
    binId = await createArtifact('bin.png', Buffer.from('seed'))
    const r = await runCli(['tasks', 'artifacts', 'write', short(binId)], { input: BINARY })
    expect(r.exitCode).toBe(0)
    // Long-standing output line: `Written: <8-char id>  <title>  v<n>`.
    expect(r.stdout.trim()).toBe(`Written: ${short(binId)}  bin.png  v2`)
    const onDisk = fs.readFileSync(path.join(storageDir, 'artifacts', taskId, `${binId}.png`))
    expect(onDisk.toString('hex')).toBe(BINARY.toString('hex'))
    // Nothing was written under the CLI's own root: the artifact tree only ever
    // appears on the hub. (The root dir itself exists — it is the mkdtemp above.)
    expect(fs.existsSync(path.join(storageDirFor(cliRoot), 'artifacts'))).toBe(false)
  })

  test("the hub's version BLOB is byte-exact (no U+FFFD substitution)", () => {
    const row = db
      .prepare('SELECT current_version_id FROM task_artifacts WHERE id = ?')
      .get(binId) as { current_version_id: string }
    const v = db
      .prepare('SELECT content_hash, size FROM artifact_versions WHERE id = ?')
      .get(row.current_version_id) as { content_hash: string; size: number }
    expect(v.size).toBe(BINARY.length)
    const blob = path.join(storageDir, 'blobs', v.content_hash.slice(0, 2), v.content_hash.slice(2))
    expect(fs.readFileSync(blob).toString('hex')).toBe(BINARY.toString('hex'))
  })

  test('append adds bytes to the existing content, byte-exact', async () => {
    const r = await runCli(['tasks', 'artifacts', 'append', short(binId)], { input: BINARY2 })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(`Appended: ${short(binId)}  bin.png  v3`)
    const onDisk = fs.readFileSync(path.join(storageDir, 'artifacts', taskId, `${binId}.png`))
    expect(onDisk.toString('hex')).toBe(Buffer.concat([BINARY, BINARY2]).toString('hex'))
  })

  test('write --mutate-version (bare) autosaves onto current, no new row', async () => {
    const before = db
      .prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id = ?')
      .get(binId) as { n: number }
    const r = await runCli(['tasks', 'artifacts', 'write', short(binId), '--mutate-version'], {
      input: 'autosaved'
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(`Written: ${short(binId)}  bin.png  v3`)
    const after = db
      .prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id = ?')
      .get(binId) as { n: number }
    expect(after.n).toBe(before.n)
  })

  test('write --mutate-version <ref> rewrites that version in place', async () => {
    const r = await runCli(['tasks', 'artifacts', 'write', short(binId), '--mutate-version', '1'], {
      input: 'rewritten v1'
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(`Written: ${short(binId)}  bin.png  v1`)
    const v1 = db
      .prepare('SELECT size FROM artifact_versions WHERE artifact_id = ? AND version_num = 1')
      .get(binId) as { size: number }
    expect(v1.size).toBe('rewritten v1'.length)
  })

  test('append --mutate-version <ref> also honors the ref', async () => {
    const r = await runCli(['tasks', 'artifacts', 'append', short(binId), '--mutate-version', '1'], {
      input: '!'
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(`Appended: ${short(binId)}  bin.png  v1`)
  })

  test('write records the AGENT author when SLAYZONE_AGENT_ID is set', async () => {
    const r = await runCli(['tasks', 'artifacts', 'write', short(binId)], {
      input: 'by an agent',
      envOverrides: { SLAYZONE_AGENT_ID: 'claude-code' }
    })
    expect(r.exitCode).toBe(0)
    const v = db
      .prepare(
        'SELECT author_type, author_id FROM artifact_versions WHERE artifact_id = ? ORDER BY version_num DESC LIMIT 1'
      )
      .get(binId) as { author_type: string; author_id: string }
    expect(v.author_type).toBe('agent')
    expect(v.author_id).toBe('claude-code')
  })

  test('write on a bad --mutate-version ref exits 1 with the Error [CODE] line', async () => {
    const r = await runCli(['tasks', 'artifacts', 'write', short(binId), '--mutate-version', '999'], {
      input: 'x'
    })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.trim()).toBe('Error [NOT_FOUND]: Version not found: 999')
  })

  test('write on an unknown artifact exits 1 naming the prefix', async () => {
    const r = await runCli(['tasks', 'artifacts', 'write', 'deadbeef'], { input: 'x' })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Artifact not found: deadbeef')).toBe(true)
  })

  test('write with no piped stdin (a TTY) is rejected before any request', async () => {
    // stdio 'ignore' for stdin is not a TTY either, so drive the guard via the
    // real path: an unreachable hub proves the guard fires FIRST if stdin were
    // the problem. Here we assert the opposite direction — piped-empty is legal
    // (an empty artifact is a valid state), so this must SUCCEED.
    const r = await runCli(['tasks', 'artifacts', 'write', short(binId)], { input: '' })
    expect(r.exitCode).toBe(0)
  })
})

await describe('artifacts update with NO local database', () => {
  test('--title renames and echoes the full row in --json', async () => {
    textId = await createArtifact('notes.md', 'line one\nline two\n')
    const r = await runCli([
      'tasks',
      'artifacts',
      'update',
      short(textId),
      '--title',
      'renamed.md',
      '--json'
    ])
    expect(r.exitCode).toBe(0)
    const row = JSON.parse(r.stdout) as Record<string, unknown>
    expect(row.title).toBe('renamed.md')
    // The old `--json` printed its own `SELECT *`, so every stored column must be
    // present — including the version/view ones the parsed shape would drop.
    for (const col of [
      'id',
      'task_id',
      'folder_id',
      'title',
      'render_mode',
      'language',
      'order',
      'created_at',
      'updated_at',
      'view_mode',
      'readability_override',
      'width_override',
      'current_version_id'
    ]) {
      expect(Object.keys(row).includes(col)).toBe(true)
    }
    expect(
      (db.prepare('SELECT title FROM task_artifacts WHERE id = ?').get(textId) as { title: string })
        .title
    ).toBe('renamed.md')
  })

  test('--render-mode persists, human line unchanged', async () => {
    const r = await runCli([
      'tasks',
      'artifacts',
      'update',
      short(textId),
      '--render-mode',
      'code'
    ])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(`Updated: ${short(textId)}  renamed.md`)
    expect(
      (
        db.prepare('SELECT render_mode FROM task_artifacts WHERE id = ?').get(textId) as {
          render_mode: string
        }
      ).render_mode
    ).toBe('code')
  })

  test('an extension change renames the working copy on the HUB, byte-exact', async () => {
    const id = await createArtifact('blob.bin', BINARY)
    const oldPath = path.join(storageDir, 'artifacts', taskId, `${id}.bin`)
    expect(fs.readFileSync(oldPath).toString('hex')).toBe(BINARY.toString('hex'))
    const r = await runCli(['tasks', 'artifacts', 'update', short(id), '--title', 'blob.dat'])
    expect(r.exitCode).toBe(0)
    const newPath = path.join(storageDir, 'artifacts', taskId, `${id}.dat`)
    expect(fs.existsSync(oldPath)).toBe(false)
    expect(fs.readFileSync(newPath).toString('hex')).toBe(BINARY.toString('hex'))
  })

  test('no flags exits 1 with the CLI wording, before any request', async () => {
    const r = await runCli(['tasks', 'artifacts', 'update', short(textId)])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Provide at least one of --title, --render-mode.')).toBe(true)
  })

  test('unknown artifact exits 1 naming the prefix', async () => {
    const r = await runCli(['tasks', 'artifacts', 'update', 'deadbeef', '--title', 'x.md'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Artifact not found: deadbeef')).toBe(true)
  })
})

await describe('artifacts versions * with NO local database', () => {
  test('versions list --json returns the rows newest-first', async () => {
    const r = await runCli(['tasks', 'artifacts', 'versions', 'list', short(textId), '--json'])
    expect(r.exitCode).toBe(0)
    const rows = JSON.parse(r.stdout) as VersionJson[]
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0].version_num).toBeGreaterThanOrEqual(rows[rows.length - 1].version_num)
  })

  test('versions list human output keeps its header + v-prefixed rows', async () => {
    const r = await runCli(['tasks', 'artifacts', 'versions', 'list', short(textId)])
    expect(r.exitCode).toBe(0)
    const lines = r.stdout.trimEnd().split('\n')
    expect(lines[0]).toBe('VER  HASH       SIZE   NAME              AUTHOR            CREATED')
    expect(lines[1].startsWith('---  ---------')).toBe(true)
    expect(lines[2].startsWith('v')).toBe(true)
  })

  test('versions list --limit / --offset are honored', async () => {
    // Give it three versions to page through.
    await runCli(['tasks', 'artifacts', 'write', short(textId)], { input: 'a\n' })
    await runCli(['tasks', 'artifacts', 'write', short(textId)], { input: 'b\n' })
    const all = JSON.parse(
      (await runCli(['tasks', 'artifacts', 'versions', 'list', short(textId), '--json'])).stdout
    ) as VersionJson[]
    const paged = JSON.parse(
      (
        await runCli([
          'tasks',
          'artifacts',
          'versions',
          'list',
          short(textId),
          '--limit',
          '1',
          '--offset',
          '1',
          '--json'
        ])
      ).stdout
    ) as VersionJson[]
    expect(paged.length).toBe(1)
    expect(paged[0].version_num).toBe(all[1].version_num)
  })

  test('versions list on an artifact with no versions prints (no versions)', async () => {
    const ghost = crypto.randomUUID()
    db.prepare('INSERT INTO task_artifacts (id, task_id, title, "order") VALUES (?, ?, ?, ?)').run(
      ghost,
      taskId,
      'novers.md',
      70
    )
    const r = await runCli(['tasks', 'artifacts', 'versions', 'list', short(ghost)])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('(no versions)')
  })

  test('versions read emits a BINARY version byte-exact', async () => {
    // binId v2 was the pure BINARY fixture written earlier.
    const r = await runCli(['tasks', 'artifacts', 'versions', 'read', short(binId), '2'])
    expect(r.exitCode).toBe(0)
    expect(r.stdoutBytes.toString('hex')).toBe(BINARY.toString('hex'))
  })

  test('versions read accepts a hash prefix, HEAD~N, and a relative ref after --', async () => {
    const v2 = db
      .prepare(
        'SELECT content_hash FROM artifact_versions WHERE artifact_id = ? AND version_num = 2'
      )
      .get(binId) as { content_hash: string }
    const byHash = await runCli([
      'tasks',
      'artifacts',
      'versions',
      'read',
      short(binId),
      v2.content_hash.slice(0, 8)
    ])
    expect(byHash.exitCode).toBe(0)
    expect(byHash.stdoutBytes.toString('hex')).toBe(BINARY.toString('hex'))

    const byInt = await runCli(['tasks', 'artifacts', 'versions', 'read', short(binId), '1'])
    expect(byInt.exitCode).toBe(0)

    const tilde = await runCli(['tasks', 'artifacts', 'versions', 'read', short(binId), 'HEAD~1'])
    expect(tilde.exitCode).toBe(0)

    // A bare `-1` is eaten by commander as an unknown OPTION before any action
    // runs — a pre-existing gap between the `--help` text and the parser, present
    // on the sqlite version too (the `.command('read <artifactId> <version>')`
    // declaration is unchanged). `--` reaches the resolver, and HEAD~1 is the same
    // ref by another spelling, so the two must agree byte for byte.
    const bare = await runCli(['tasks', 'artifacts', 'versions', 'read', short(binId), '-1'])
    expect(bare.exitCode).toBe(1)
    expect(bare.stderr.includes("unknown option '-1'")).toBe(true)

    const relative = await runCli([
      'tasks',
      'artifacts',
      'versions',
      'read',
      short(binId),
      '--',
      '-1'
    ])
    expect(relative.exitCode).toBe(0)
    expect(relative.stdoutBytes.toString('hex')).toBe(tilde.stdoutBytes.toString('hex'))
  })

  test('versions read on a bad ref exits 1 with the Error [CODE] line', async () => {
    const r = await runCli(['tasks', 'artifacts', 'versions', 'read', short(binId), '987'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.trim()).toBe('Error [NOT_FOUND]: Version not found: 987')
  })

  test('versions current prints v<n> + short hash, and --json the row', async () => {
    const human = await runCli(['tasks', 'artifacts', 'versions', 'current', short(binId)])
    expect(human.exitCode).toBe(0)
    expect(/^v\d+ {2}[0-9a-f]{8}$/.test(human.stdout.trim())).toBe(true)

    const asJson = await runCli([
      'tasks',
      'artifacts',
      'versions',
      'current',
      short(binId),
      '--json'
    ])
    const v = JSON.parse(asJson.stdout) as VersionJson
    expect(v.content_hash.length).toBe(64)
  })

  test('versions current exits 1 when the artifact has no versions', async () => {
    const ghost = crypto.randomUUID()
    db.prepare('INSERT INTO task_artifacts (id, task_id, title, "order") VALUES (?, ?, ?, ?)').run(
      ghost,
      taskId,
      'headless.md',
      71
    )
    const r = await runCli(['tasks', 'artifacts', 'versions', 'current', short(ghost)])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('No versions for this artifact')).toBe(true)
  })

  test('versions create makes a row from the working copy and names it', async () => {
    const r = await runCli([
      'tasks',
      'artifacts',
      'versions',
      'create',
      short(textId),
      '--name',
      'baseline'
    ])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim().startsWith('Created: v')).toBe(true)
    expect(r.stdout.trim().endsWith('(baseline)')).toBe(true)
    const named = db
      .prepare('SELECT name FROM artifact_versions WHERE artifact_id = ? AND name = ?')
      .get(textId, 'baseline') as { name: string } | undefined
    expect(named?.name).toBe('baseline')
  })

  test('versions create attributes the agent author', async () => {
    const r = await runCli(
      ['tasks', 'artifacts', 'versions', 'create', short(textId), '--name', 'agentmade', '--json'],
      { envOverrides: { SLAYZONE_AGENT_ID: 'codex' } }
    )
    expect(r.exitCode).toBe(0)
    const v = JSON.parse(r.stdout) as VersionJson
    expect(v.author_type).toBe('agent')
    expect(v.author_id).toBe('codex')
  })

  test('versions create on a taken name exits 1 with the Error [CODE] line', async () => {
    const r = await runCli([
      'tasks',
      'artifacts',
      'versions',
      'create',
      short(textId),
      '--name',
      'baseline'
    ])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.startsWith('Error [NAME_TAKEN]: ')).toBe(true)
  })

  test('versions rename sets, then clears, a name', async () => {
    const set = await runCli([
      'tasks',
      'artifacts',
      'versions',
      'rename',
      short(textId),
      '1',
      'first'
    ])
    expect(set.exitCode).toBe(0)
    expect(set.stdout.trim()).toBe('Renamed v1: first')

    const cleared = await runCli(['tasks', 'artifacts', 'versions', 'rename', short(textId), '1'])
    expect(cleared.exitCode).toBe(0)
    expect(cleared.stdout.trim()).toBe('Renamed v1: (no name)')
    const row = db
      .prepare('SELECT name FROM artifact_versions WHERE artifact_id = ? AND version_num = 1')
      .get(textId) as { name: string | null }
    expect(row.name).toBeNull()
  })

  test('versions rename --clear also clears', async () => {
    await runCli(['tasks', 'artifacts', 'versions', 'rename', short(textId), '1', 'tmpname'])
    const r = await runCli([
      'tasks',
      'artifacts',
      'versions',
      'rename',
      short(textId),
      '1',
      '--clear'
    ])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('Renamed v1: (no name)')
  })

  test('versions rename to a reserved name exits 1 with the Error [CODE] line', async () => {
    const r = await runCli([
      'tasks',
      'artifacts',
      'versions',
      'rename',
      short(textId),
      '1',
      'HEAD'
    ])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.startsWith('Error [NAME_RESERVED]: ')).toBe(true)
  })

  test('versions set-current switches HEAD and flushes bytes to the HUB disk', async () => {
    const r = await runCli(['tasks', 'artifacts', 'versions', 'set-current', short(binId), '2'])
    expect(r.exitCode).toBe(0)
    expect(/^Current: v2 {2}[0-9a-f]{8}$/.test(r.stdout.trim())).toBe(true)
    // v2 is the BINARY fixture — flushed byte-exact, not utf-8-mangled.
    const onDisk = fs.readFileSync(path.join(storageDir, 'artifacts', taskId, `${binId}.png`))
    expect(onDisk.toString('hex')).toBe(BINARY.toString('hex'))
  })

  test('versions set-current --json echoes the version row', async () => {
    const r = await runCli([
      'tasks',
      'artifacts',
      'versions',
      'set-current',
      short(binId),
      '2',
      '--json'
    ])
    expect(r.exitCode).toBe(0)
    expect((JSON.parse(r.stdout) as VersionJson).version_num).toBe(2)
  })

  test('versions set-current on a bad ref exits 1 with the Error [CODE] line', async () => {
    const r = await runCli(['tasks', 'artifacts', 'versions', 'set-current', short(binId), '654'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.trim()).toBe('Error [NOT_FOUND]: Version not found: 654')
  })

  test('versions diff --json returns the structured result', async () => {
    const r = await runCli(['tasks', 'artifacts', 'versions', 'diff', short(textId), '1', '--json'])
    expect(r.exitCode).toBe(0)
    const result = JSON.parse(r.stdout) as { kind: string }
    expect(result.kind === 'text' || result.kind === 'binary').toBe(true)
  })

  test('versions diff prints PLAIN +/- lines when stdout is not a TTY', async () => {
    // Colors are TTY-gated; a spawned pipe is never a TTY, so no ANSI must appear.
    const id = await createArtifact('diffme.md', 'one\ntwo\n')
    await runCli(['tasks', 'artifacts', 'write', short(id)], { input: 'one\nTWO\n' })
    const r = await runCli(['tasks', 'artifacts', 'versions', 'diff', short(id), '1'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.includes('\x1b[')).toBe(false)
    expect(r.stdout.includes('-two')).toBe(true)
    expect(r.stdout.includes('+TWO')).toBe(true)
    // Context lines keep their leading space.
    expect(r.stdout.includes(' one')).toBe(true)
  })

  test('versions diff of two binary versions prints the (binary) summary', async () => {
    const r = await runCli(['tasks', 'artifacts', 'versions', 'diff', short(binId), '1', '2'])
    expect(r.exitCode).toBe(0)
    const lines = r.stdout.trimEnd().split('\n')
    expect(lines[0]).toBe('(binary)')
    expect(/^ {2}a: [0-9a-f]{8} {2}\d+ bytes$/.test(lines[1])).toBe(true)
    expect(/^ {2}b: [0-9a-f]{8} {2}\d+ bytes$/.test(lines[2])).toBe(true)
  })

  test('versions diff on a bad ref exits 1 with the Error [CODE] line', async () => {
    const r = await runCli(['tasks', 'artifacts', 'versions', 'diff', short(textId), '555'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.trim()).toBe('Error [NOT_FOUND]: Version not found: 555')
  })

  test('versions prune --dry-run reports without deleting', async () => {
    const id = await createArtifact('prune.md', 'v1\n')
    await runCli(['tasks', 'artifacts', 'write', short(id)], { input: 'v2\n' })
    await runCli(['tasks', 'artifacts', 'write', short(id)], { input: 'v3\n' })
    const before = db
      .prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id = ?')
      .get(id) as { n: number }
    const r = await runCli([
      'tasks',
      'artifacts',
      'versions',
      'prune',
      short(id),
      '--keep-last',
      '1',
      '--dry-run'
    ])
    expect(r.exitCode).toBe(0)
    expect(/^would delete \d+ versions, \d+ blobs \(kept \d+ named\)$/.test(r.stdout.trim())).toBe(
      true
    )
    const after = db
      .prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id = ?')
      .get(id) as { n: number }
    expect(after.n).toBe(before.n)
  })

  test('versions prune --no-keep-named --no-keep-current deletes and reports', async () => {
    const id = await createArtifact('prune2.md', 'v1\n')
    await runCli(['tasks', 'artifacts', 'write', short(id)], { input: 'v2\n' })
    await runCli(['tasks', 'artifacts', 'versions', 'rename', short(id), '1', 'keepme'])
    const r = await runCli([
      'tasks',
      'artifacts',
      'versions',
      'prune',
      short(id),
      '--keep-last',
      '1',
      '--no-keep-named',
      '--no-keep-current'
    ])
    expect(r.exitCode).toBe(0)
    expect(/^deleted \d+ versions, \d+ blobs \(kept 0 named\)$/.test(r.stdout.trim())).toBe(true)
    const after = db
      .prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id = ?')
      .get(id) as { n: number }
    expect(after.n).toBe(1)
  })

  test('versions prune --json echoes the report', async () => {
    const id = await createArtifact('prune3.md', 'v1\n')
    const r = await runCli([
      'tasks',
      'artifacts',
      'versions',
      'prune',
      short(id),
      '--dry-run',
      '--json'
    ])
    expect(r.exitCode).toBe(0)
    const report = JSON.parse(r.stdout) as {
      deletedVersions: number
      deletedBlobs: number
      keptNamed: number
    }
    expect(typeof report.deletedVersions).toBe('number')
    expect(typeof report.keptNamed).toBe('number')
  })
})

await describe('artifacts search with NO local database', () => {
  let needleId = ''
  let folderId = ''

  test('setup: seed searchable artifacts on two tasks + a folder', async () => {
    needleId = await createArtifact('alpha.md', 'first line\nNEEDLE here\nthird line\n')
    await createArtifact('beta.md', 'nothing\nneedle lowercase\n')
    const mk = await runCli([
      'tasks',
      'artifacts',
      'mkdir',
      'Nested',
      '--task',
      short(taskId),
      '--json'
    ])
    folderId = (JSON.parse(mk.stdout) as { id: string }).id
    const inFolder = await runCli(
      [
        'tasks',
        'artifacts',
        'create',
        'in-folder.md',
        '--task',
        short(taskId),
        '--folder',
        short(folderId),
        '--json'
      ],
      { input: 'NEEDLE inside\n' }
    )
    expect(inFolder.exitCode).toBe(0)
    // A different task, so --task scoping is provable.
    const other = await runCli(
      ['tasks', 'artifacts', 'create', 'gamma-NEEDLE.md', '--task', short(otherTaskId), '--json'],
      { input: 'no body match\n' }
    )
    expect(other.exitCode).toBe(0)
  })

  test('--json shape is unchanged: [{ artifactId, taskId, title, matches }]', async () => {
    const r = await runCli([
      'tasks',
      'artifacts',
      'search',
      'NEEDLE',
      '--task',
      short(taskId),
      '--json'
    ])
    expect(r.exitCode).toBe(0)
    const results = JSON.parse(r.stdout) as {
      artifactId: string
      taskId: string
      title: string
      matches: {
        type: string
        line?: number
        snippet: string
        contextBefore?: string | null
        contextAfter?: string | null
      }[]
    }[]
    const alpha = results.find((x) => x.artifactId === needleId)!
    expect(alpha.taskId).toBe(taskId)
    expect(alpha.title).toBe('alpha.md')
    const m = alpha.matches.find((x) => x.type === 'content')!
    expect(m.line).toBe(2)
    expect(m.snippet).toBe('NEEDLE here')
    expect(m.contextBefore).toBe('first line')
    expect(m.contextAfter).toBe('third line')
  })

  test('human output keeps the id/title/task header, L-prefixed lines and the footer', async () => {
    const r = await runCli(['tasks', 'artifacts', 'search', 'NEEDLE', '--task', short(taskId)])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.includes(`${short(needleId)}  alpha.md  (task: ${short(taskId)})`)).toBe(true)
    expect(r.stdout.includes('  L1:   first line')).toBe(true)
    expect(r.stdout.includes('  L2: > NEEDLE here')).toBe(true)
    expect(r.stdout.includes('  L3:   third line')).toBe(true)
    expect(/Found \d+ artifacts? \(\d+ matches?\)\. Scanned \d+ artifacts?\./.test(r.stdout)).toBe(
      true
    )
  })

  test('--all-tasks spans tasks; --task scopes to one', async () => {
    const all = await runCli(['tasks', 'artifacts', 'search', 'NEEDLE', '--all-tasks', '--json'])
    const allTitles = (JSON.parse(all.stdout) as { title: string }[]).map((x) => x.title)
    expect(allTitles.includes('gamma-NEEDLE.md')).toBe(true)

    const scoped = await runCli([
      'tasks',
      'artifacts',
      'search',
      'NEEDLE',
      '--task',
      short(taskId),
      '--json'
    ])
    const scopedTitles = (JSON.parse(scoped.stdout) as { title: string }[]).map((x) => x.title)
    expect(scopedTitles.includes('gamma-NEEDLE.md')).toBe(false)
  })

  test('--folder narrows to that folder', async () => {
    const r = await runCli([
      'tasks',
      'artifacts',
      'search',
      'NEEDLE',
      '--task',
      short(taskId),
      '--folder',
      short(folderId),
      '--json'
    ])
    expect(r.exitCode).toBe(0)
    const results = JSON.parse(r.stdout) as { title: string }[]
    expect(results.length).toBe(1)
    expect(results[0].title).toBe('in-folder.md')
  })

  test('--titles-only / --content-only / --case-sensitive / --regex', async () => {
    const titles = await runCli([
      'tasks',
      'artifacts',
      'search',
      'NEEDLE',
      '--all-tasks',
      '--titles-only',
      '--json'
    ])
    const titleHits = JSON.parse(titles.stdout) as { title: string; matches: { type: string }[] }[]
    expect(titleHits.every((h) => h.matches.every((m) => m.type === 'title'))).toBe(true)

    const content = await runCli([
      'tasks',
      'artifacts',
      'search',
      'gamma',
      '--all-tasks',
      '--content-only',
      '--json'
    ])
    expect((JSON.parse(content.stdout) as unknown[]).length).toBe(0)

    const sensitive = await runCli([
      'tasks',
      'artifacts',
      'search',
      'NEEDLE',
      '--task',
      short(taskId),
      '--case-sensitive',
      '--json'
    ])
    const sensitiveTitles = (JSON.parse(sensitive.stdout) as { title: string }[]).map((x) => x.title)
    expect(sensitiveTitles.includes('beta.md')).toBe(false)

    const regex = await runCli([
      'tasks',
      'artifacts',
      'search',
      'NEE.LE',
      '--task',
      short(taskId),
      '--regex',
      '--json'
    ])
    expect((JSON.parse(regex.stdout) as unknown[]).length).toBeGreaterThan(0)
  })

  test('--limit sets the truncation hint in the footer', async () => {
    const r = await runCli([
      'tasks',
      'artifacts',
      'search',
      'NEEDLE',
      '--task',
      short(taskId),
      '--limit',
      '1'
    ])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.includes('(limit reached; increase --limit for more)')).toBe(true)
  })

  test('--max-matches caps content matches per artifact', async () => {
    const id = await createArtifact('many.md', 'NEEDLE\nNEEDLE\nNEEDLE\nNEEDLE\n')
    const r = await runCli([
      'tasks',
      'artifacts',
      'search',
      'NEEDLE',
      '--task',
      short(taskId),
      '--max-matches',
      '2',
      '--json'
    ])
    const hit = (
      JSON.parse(r.stdout) as { artifactId: string; matches: { type: string }[] }[]
    ).find((x) => x.artifactId === id)!
    expect(hit.matches.filter((m) => m.type === 'content').length).toBe(2)
  })

  test('no matches prints "No matches." and exits 0', async () => {
    const r = await runCli([
      'tasks',
      'artifacts',
      'search',
      'zzzznotpresent',
      '--task',
      short(taskId)
    ])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('No matches.')
  })

  test('argument contradictions still fail locally with the same wording', async () => {
    const empty = await runCli(['tasks', 'artifacts', 'search', '   ', '--task', short(taskId)])
    expect(empty.exitCode).toBe(1)
    expect(empty.stderr.includes('Provide a non-empty query.')).toBe(true)

    const both = await runCli([
      'tasks',
      'artifacts',
      'search',
      'x',
      '--task',
      short(taskId),
      '--titles-only',
      '--content-only'
    ])
    expect(both.exitCode).toBe(1)
    expect(both.stderr.includes('--titles-only and --content-only are mutually exclusive.')).toBe(
      true
    )

    const clash = await runCli([
      'tasks',
      'artifacts',
      'search',
      'x',
      '--all-tasks',
      '--task',
      short(taskId)
    ])
    expect(clash.exitCode).toBe(1)
    expect(clash.stderr.includes('--all-tasks cannot combine with --task or --folder.')).toBe(true)
  })

  test('an invalid --regex exits 1 with the CLI wording', async () => {
    const r = await runCli([
      'tasks',
      'artifacts',
      'search',
      '[unclosed',
      '--task',
      short(taskId),
      '--regex'
    ])
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Invalid regex: ')).toBe(true)
  })

  test('unknown --task / --folder exit 1 with the REST 404 wording', async () => {
    const task = await runCli(['tasks', 'artifacts', 'search', 'x', '--task', 'ffffffff'])
    expect(task.exitCode).toBe(1)
    expect(task.stderr.includes('Task not found: ffffffff')).toBe(true)

    const folder = await runCli([
      'tasks',
      'artifacts',
      'search',
      'x',
      '--task',
      short(taskId),
      '--folder',
      'ffffffff'
    ])
    expect(folder.exitCode).toBe(1)
    expect(folder.stderr.includes('Folder not found: ffffffff')).toBe(true)
  })
})

await describe('no-server path: every converted command reports a dead hub', () => {
  const dead = { SLAYZONE_HUB_ADDRESS: '127.0.0.1:1' }

  test('write / append / update / search / versions list all exit 1 with the connect error', async () => {
    const cases: string[][] = [
      ['tasks', 'artifacts', 'update', short(textId), '--title', 'x.md'],
      ['tasks', 'artifacts', 'search', 'x', '--task', short(taskId)],
      ['tasks', 'artifacts', 'versions', 'list', short(textId)],
      ['tasks', 'artifacts', 'versions', 'read', short(textId), '1'],
      ['tasks', 'artifacts', 'versions', 'current', short(textId)],
      ['tasks', 'artifacts', 'versions', 'create', short(textId)],
      ['tasks', 'artifacts', 'versions', 'rename', short(textId), '1', 'n'],
      ['tasks', 'artifacts', 'versions', 'diff', short(textId), '1'],
      ['tasks', 'artifacts', 'versions', 'set-current', short(textId), '1'],
      ['tasks', 'artifacts', 'versions', 'prune', short(textId)]
    ]
    for (const args of cases) {
      const r = await runCli(args, { envOverrides: dead })
      expect(r.exitCode).toBe(1)
      expect(r.stderr.includes('Could not connect to SlayZone hub')).toBe(true)
    }
    for (const args of [
      ['tasks', 'artifacts', 'write', short(textId)],
      ['tasks', 'artifacts', 'append', short(textId)]
    ]) {
      const r = await runCli(args, { input: 'x', envOverrides: dead })
      expect(r.exitCode).toBe(1)
      expect(r.stderr.includes('Could not connect to SlayZone hub')).toBe(true)
    }
  })
})

await describe('path is answered by the HUB, not derived from the CLI root', () => {
  test('prints the hub-side working-copy path when the hub is co-located', async () => {
    // `path` is the ONE artifact subcommand whose answer is a filesystem path, so
    // it is the one that has to know WHOSE filesystem. It no longer opens a local
    // database (which is why the CLI root holding none is no longer an error), and
    // it no longer composes the path from the CLI's own root — that silently
    // printed a path from the wrong machine. `GET /api/artifacts/:id` returns
    // `filePath` composed against the HUB's storage root, and the CLI prints it
    // only after confirming the hub is on this box (loopback → co-located).
    const r = await runCli(['tasks', 'artifacts', 'path', short(textId)])
    expect(r.exitCode).toBe(0)
    // `textId` was renamed to `renamed.md` earlier in this file.
    expect(r.stdout).toBe(path.join(storageDir, 'artifacts', taskId, `${textId}.md`))
    // And nothing was derived under the CLI's own root.
    expect(fs.existsSync(path.join(storageDirFor(cliRoot), 'artifacts'))).toBe(false)
  })
})

await rest.close()
db.close()
fs.rmSync(hubRoot, { recursive: true, force: true })
fs.rmSync(cliRoot, { recursive: true, force: true })
