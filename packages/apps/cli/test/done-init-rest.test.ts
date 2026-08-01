/**
 * CLI → REST integration tests for `slay tasks done` (incl. `--close`) and `slay init`.
 *
 * Both commands used to open the hub's SQLite file directly, so neither worked
 * against a hub on another machine (`openDb()` → "Database not found" +
 * `process.exit(1)`). The suites below run the bundled CLI with `SLAYZONE_ROOT`
 * pointed at a directory that holds NO database — the hub has the DB, this CLI
 * does not — which is the whole point of the cutover.
 *
 * Spawns the bundled CLI (dist/slay.js) as a subprocess against an in-process
 * Express+REST stack on an ephemeral port. Subprocess is required because the
 * CLI source is loaded as CJS by tsx and pulls in @slayzone/* ESM modules; if we
 * direct-imported CLI actions here the REST routes' transitive ESM imports would
 * trigger an unbreakable require(esm) cycle. (Same rationale as tasks-rest.test.ts.)
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/apps/cli/test/done-init-rest.test.ts
 *
 * Pre-req: pnpm --filter @slayzone/cli build  (or rely on existing dist/slay.js)
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
import { configureTaskRuntimeAdapters } from '../../../domains/task/src/server/ops/shared.js'
import { mountRestApp } from '../../../shared/test-utils/rest-harness.js'
import { DB_PRAGMAS } from '../../../shared/platform/src/index.js'
import { BUILTIN_SKILLS, PROVIDER_PATHS } from '../../../domains/ai-config/src/shared/index.js'
import { registerDoneTaskRoute } from '../../../shared/transport/src/server/http/rest-api/tasks/done.js'
import { registerProjectSkillsRoute } from '../../../shared/transport/src/server/http/rest-api/projects/skills.js'
import { registerProjectsResolveByPathRoute } from '../../../shared/transport/src/server/http/rest-api/projects/resolve-by-path.js'
import { registerNotifyRoute } from '../../../shared/transport/src/server/http/rest-api/notify.js'
import { ipcMain } from '../../../shared/test-utils/mock-electron.js'

const SLAY_BIN = path.resolve(import.meta.dirname, '../dist/slay.js')
if (!fs.existsSync(SLAY_BIN)) {
  console.error(`SKIP: dist/slay.js not built. Run \`pnpm --filter @slayzone/cli build\` first.`)
  process.exit(0)
}

// The HUB's install root: it holds the database. `SLAYZONE_DEV=1` below picks the
// `.dev` filename, so the fixture DB has to live exactly at <ROOT>/storage/…
const hubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-done-init-hub-'))
const storageDir = path.join(hubRoot, 'storage')
fs.mkdirSync(storageDir, { recursive: true })

const db = new Database(path.join(storageDir, 'slayzone.dev.sqlite'))
for (const pragma of DB_PRAGMAS) db.pragma(pragma)
const migrationsPath = path.resolve(
  import.meta.dirname,
  '../../../shared/transport/src/db-bootstrap/migrations.ts'
)
const mod = await import(migrationsPath)
mod.runMigrations(db)
const slayDb = createSlayzoneDbAdapter(db)
configureTaskRuntimeAdapters({ getDataRoot: () => hubRoot })

const projectId = crypto.randomUUID()
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-done-init-proj-'))
db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
  projectId,
  'DONEINIT',
  '#000',
  projectDir
)

// Custom-columns project: completed column is `closed`, and no column is named
// "done" — so `slay tasks done` can only be right if the HUB decides which
// column "done" means.
const customProjectId = crypto.randomUUID()
db.prepare(
  'INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)'
).run(
  customProjectId,
  'CUSTOMCOLS',
  '#000',
  null,
  JSON.stringify([
    { id: 'queue', label: 'Queue', color: 'gray', position: 0, category: 'unstarted' },
    { id: 'doing', label: 'Doing', color: 'blue', position: 1, category: 'started' },
    { id: 'closed', label: 'Closed', color: 'green', position: 2, category: 'completed' },
    { id: 'wontfix', label: 'Wontfix', color: 'slate', position: 3, category: 'canceled' }
  ])
)

let notifyCount = 0
const closeEmits: string[] = []
const app = express()
app.use(express.json())
const taskBus = ipcMain as unknown as { emit: (channel: string, ...args: unknown[]) => boolean }
const deps = {
  db: slayDb,
  taskBus,
  notifyRenderer: () => {
    notifyCount++
  },
  // `--close` reaches the UI through the injected menu bus, exactly as the
  // Electron host wires it. Capturing it here is what proves the CLI's
  // `--close` no longer needs the hub's DB to find a port.
  menu: {
    emit: (channel: string, ...args: unknown[]) => {
      if (channel === 'close-task') closeEmits.push(args[0] as string)
      return true
    }
  }
}
registerDoneTaskRoute(app, deps as never)
registerProjectSkillsRoute(app, deps as never)
registerProjectsResolveByPathRoute(app, deps as never)
registerNotifyRoute(app, deps as never)
const rest = await mountRestApp(app)

interface CliResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

function runCli(
  args: string[],
  opts: { env?: Record<string, string | undefined>; cwd?: string } = {}
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      SLAYZONE_ROOT: hubRoot,
      SLAYZONE_DEV: '1',
      // Authority only (host:port) — the http scheme derives from SLAYZONE_MODE.
      SLAYZONE_HUB_ADDRESS: `127.0.0.1:${rest.port}`
    }
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const p = spawn('node', [SLAY_BIN, ...args], {
      env,
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    })
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

function seedTask(title: string, pid = projectId, id = crypto.randomUUID()): string {
  db.prepare(
    'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, pid, title, 'todo', 3, 0)
  return id
}

/**
 * A root with NO database file. Every test below runs the CLI against it: the
 * hub still has the DB, this CLI does not.
 */
const noDbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-no-db-done-init-'))
const noDbEnv = { SLAYZONE_ROOT: noDbRoot }

await describe('slay tasks done works without a local database', () => {
  test('sanity: this root really has no database file', () => {
    expect(fs.existsSync(path.join(noDbRoot, 'storage', 'slayzone.dev.sqlite'))).toBe(false)
  })

  test('tasks done <prefix> writes the project done status + echoes id/title', async () => {
    const id = seedTask('DoneMe')
    const r = await runCli(['tasks', 'done', id.slice(0, 8)], { env: noDbEnv })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.includes(`Done: ${id.slice(0, 8)}  DoneMe`)).toBe(true)
    const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }
    expect(row.status).toBe('done')
  })

  test('tasks done resolves CUSTOM project columns (closed, not literal "done")', async () => {
    const id = seedTask('DoneCustom', customProjectId)
    const r = await runCli(['tasks', 'done', id.slice(0, 8)], { env: noDbEnv })
    expect(r.exitCode).toBe(0)
    const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }
    expect(row.status).toBe('closed')
  })

  test('tasks done --close also closes the tab (no port lookup, no DB read)', async () => {
    const id = seedTask('DoneAndClose')
    closeEmits.length = 0
    const r = await runCli(['tasks', 'done', id.slice(0, 8), '--close'], { env: noDbEnv })
    expect(r.exitCode).toBe(0)
    // No "cannot close tab — no MCP port" warning: the port lookup is gone.
    expect(r.stderr.includes('no MCP port')).toBe(false)
    expect(closeEmits).toEqual([id])
    const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }
    expect(row.status).toBe('done')
  })

  test('tasks done: unknown prefix exits 1 naming what was searched for', async () => {
    const r = await runCli(['tasks', 'done', 'deadbeef'], { env: noDbEnv })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Task not found: deadbeef')).toBe(true)
  })

  test('tasks done: ambiguous prefix exits 1 and lists the candidates', async () => {
    const a = seedTask('AmbDone A', projectId, `88888888-aaaa-${crypto.randomUUID().slice(14)}`)
    const b = seedTask('AmbDone B', projectId, `88888888-cccc-${crypto.randomUUID().slice(14)}`)
    const r = await runCli(['tasks', 'done', '88888888'], { env: noDbEnv })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('Ambiguous id prefix "88888888"')).toBe(true)
    expect(r.stderr.includes(a.slice(0, 8))).toBe(true)
    expect(r.stderr.includes(b.slice(0, 8))).toBe(true)
  })
})

await describe('slay init works without a local database', () => {
  test('init skills --project installs the hub-side skill records', async () => {
    notifyCount = 0
    const r = await runCli(['init', 'skills', '--project', 'DONEINIT'], { env: noDbEnv })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.includes(`installed ${BUILTIN_SKILLS.length}`)).toBe(true)
    expect(r.stdout.includes('for "DONEINIT"')).toBe(true)
    // Per-skill lines preserved (name, not slug) — same output as before the cutover.
    expect(r.stdout.includes(`  Installed ${BUILTIN_SKILLS[0].name}`)).toBe(true)
    const rows = db
      .prepare(`SELECT scope, project_id FROM ai_config_items WHERE type = 'skill' AND project_id = ?`)
      .all(projectId) as Array<{ scope: string; project_id: string }>
    expect(rows.length).toBe(BUILTIN_SKILLS.length)
    // notifyApp() still pings the hub after a change.
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('second run reports all-up-to-date (hash comparison is server-side)', async () => {
    const r = await runCli(['init', 'skills', '--project', 'DONEINIT'], { env: noDbEnv })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.includes(`All ${BUILTIN_SKILLS.length} skills up to date for "DONEINIT"`)).toBe(
      true
    )
  })

  test('init skills mirrors SKILL.md to disk when the project path exists locally', async () => {
    // Fresh project whose configured path exists on THIS machine.
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-init-local-'))
    const localId = crypto.randomUUID()
    db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
      localId,
      'LOCALPROJ',
      '#000',
      localDir
    )
    const r = await runCli(['init', 'skills', '--project', 'LOCALPROJ'], { env: noDbEnv })
    expect(r.exitCode).toBe(0)
    const skillsDir = PROVIDER_PATHS.claude.skillsDir!
    for (const skill of BUILTIN_SKILLS) {
      const filePath = path.join(localDir, skillsDir, skill.slug, 'SKILL.md')
      expect(fs.existsSync(filePath)).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(skill.content)
    }
    fs.rmSync(localDir, { recursive: true, force: true })
  })

  test('init (default) appends root instructions when a local project path exists', async () => {
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-init-instr-'))
    const localId = crypto.randomUUID()
    db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
      localId,
      'INSTRPROJ',
      '#000',
      localDir
    )
    const r = await runCli(['init', '--project', 'INSTRPROJ'], { env: noDbEnv })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.includes('Appended instructions to CLAUDE.md')).toBe(true)
    const claudeMd = path.join(localDir, 'CLAUDE.md')
    expect(fs.existsSync(claudeMd)).toBe(true)
    expect(fs.readFileSync(claudeMd, 'utf-8').includes('# SlayZone Environment')).toBe(true)
    fs.rmSync(localDir, { recursive: true, force: true })
  })

  test('remote-shaped project (path not present locally): records land, no local writes', async () => {
    const remotePath = path.join(os.tmpdir(), `slay-not-here-${crypto.randomUUID().slice(0, 8)}`)
    expect(fs.existsSync(remotePath)).toBe(false)
    const remoteId = crypto.randomUUID()
    db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
      remoteId,
      'REMOTEPROJ',
      '#000',
      remotePath
    )
    const r = await runCli(['init', 'skills', '--project', 'REMOTEPROJ'], { env: noDbEnv })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.includes(`installed ${BUILTIN_SKILLS.length}`)).toBe(true)
    const rows = db
      .prepare(`SELECT id FROM ai_config_items WHERE type = 'skill' AND project_id = ?`)
      .all(remoteId) as Array<{ id: string }>
    expect(rows.length).toBe(BUILTIN_SKILLS.length)
    // Nothing was created on this machine for a path that does not exist here.
    expect(fs.existsSync(remotePath)).toBe(false)
  })

  test('pathless project: records land, nothing to write locally', async () => {
    const r = await runCli(['init', 'skills', '--project', 'CUSTOMCOLS'], { env: noDbEnv })
    expect(r.exitCode).toBe(0)
    const rows = db
      .prepare(`SELECT id FROM ai_config_items WHERE type = 'skill' AND project_id = ?`)
      .all(customProjectId) as Array<{ id: string }>
    expect(rows.length).toBe(BUILTIN_SKILLS.length)
  })

  test('init with no --project resolves the project from cwd via the hub', async () => {
    // realpath: on macOS os.tmpdir() is a symlink (/var → /private/var), and the
    // subprocess's process.cwd() reports the resolved form — which is what gets
    // matched against the stored project path.
    const cwdDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slay-init-cwd-')))
    const cwdId = crypto.randomUUID()
    db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
      cwdId,
      'CWDPROJ',
      '#000',
      cwdDir
    )
    const sub = path.join(cwdDir, 'src')
    fs.mkdirSync(sub, { recursive: true })
    const r = await runCli(['init', 'skills'], { env: noDbEnv, cwd: sub })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.includes('for "CWDPROJ"')).toBe(true)
    const rows = db
      .prepare(`SELECT id FROM ai_config_items WHERE type = 'skill' AND project_id = ?`)
      .all(cwdId) as Array<{ id: string }>
    expect(rows.length).toBe(BUILTIN_SKILLS.length)
    fs.rmSync(cwdDir, { recursive: true, force: true })
  })

  test('regression: `init skills --project X` honors X, never falls back to cwd', async () => {
    // Pre-existing bug (present before this cutover): `init` and `init skills` both
    // declare `-p, --project`, and commander lets the PARENT consume the flag — so
    // the subcommand's own opts() came back EMPTY and the project silently fell
    // back to cwd inference. Fixed via optsWithGlobals(). Run from a cwd that
    // resolves to a DIFFERENT project so a regression cannot pass by coincidence.
    const otherDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slay-init-other-')))
    const otherId = crypto.randomUUID()
    db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
      otherId,
      'OTHERPROJ',
      '#000',
      otherDir
    )
    const targetId = crypto.randomUUID()
    db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
      targetId,
      'TARGETPROJ',
      '#000',
      null
    )
    const r = await runCli(['init', 'skills', '--project', 'TARGETPROJ'], {
      env: noDbEnv,
      cwd: otherDir
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.includes('for "TARGETPROJ"')).toBe(true)
    const target = db
      .prepare(`SELECT id FROM ai_config_items WHERE type = 'skill' AND project_id = ?`)
      .all(targetId) as Array<{ id: string }>
    expect(target.length).toBe(BUILTIN_SKILLS.length)
    // The cwd's project was NOT touched.
    const other = db
      .prepare(`SELECT id FROM ai_config_items WHERE type = 'skill' AND project_id = ?`)
      .all(otherId) as Array<{ id: string }>
    expect(other.length).toBe(0)
    fs.rmSync(otherDir, { recursive: true, force: true })
  })

  test('init: unknown --project exits 1 with the CLI wording', async () => {
    const r = await runCli(['init', 'skills', '--project', 'totally-not-a-project'], {
      env: noDbEnv
    })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('No project matching')).toBe(true)
  })

  test('init: no project for cwd exits 1 with the CLI hint', async () => {
    const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-init-orphan-'))
    const r = await runCli(['init', 'skills'], { env: noDbEnv, cwd: orphan })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.includes('No project found for directory')).toBe(true)
    fs.rmSync(orphan, { recursive: true, force: true })
  })

  test('init instructions still prints the template with no hub at all', async () => {
    const r = await runCli(['init', 'instructions'], {
      env: { ...noDbEnv, SLAYZONE_HUB_ADDRESS: undefined }
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.includes('# SlayZone Environment')).toBe(true)
  })
})

await rest.close()
db.close()
fs.rmSync(hubRoot, { recursive: true, force: true })
fs.rmSync(noDbRoot, { recursive: true, force: true })
fs.rmSync(projectDir, { recursive: true, force: true })
