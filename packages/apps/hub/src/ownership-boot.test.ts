/**
 * Project ownership (T-16) through the REAL built hub (dist/bin.cjs), against a
 * database written by the previous schema (v168) — i.e. an upgrade:
 *
 *   - login OFF (the desktop app's hub — `SLAYZONE_SUPERVISED=1`, login 0): the hub
 *     migrates, assigns nobody, and keeps working exactly as before — a project
 *     created over REST stores no owner and every project lists.
 *   - login ON: after boot every pre-existing project belongs to the first admin
 *     (the bootstrap owner), the pre-login `viewState` moved to that admin, nothing
 *     was lost, one `project.owner.backfill` audit line names the count — and a
 *     project created over REST with the owner's bearer stores that owner.
 *
 * ownership-backfill.test.ts pins the step itself; this proves the boot runs it,
 * in the right place (after the bootstrap owner exists, before the hub serves).
 *
 * Native ABI: better-sqlite3 needs Electron's node (run_test_electron_strict_loader).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --experimental-loader ./packages/shared/test-utils/loader.ts \
 *   packages/apps/hub/src/ownership-boot.test.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { deriveBootstrapOwnerPassword } from '@slayzone/platform/hub-auth-secret'
import { BOOTSTRAP_OWNER_EMAIL } from '@slayzone/platform/hub-owner-file'
import { migrations } from '../../../shared/transport/src/db-bootstrap/index.js'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const PACKAGES_DIR = join(HUB_DIR, '..', '..')
const ELECTRON_BIN = require('electron') as unknown as string
const DB_FILE = 'slayzone.data.sqlite'

let passed = 0
let failed = 0
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    failed++
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

/** Newest source mtime under `dir`, skipping build output and dependencies. */
function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

/** The bundle inlines every workspace package, so staleness is judged on all of them. */
function ensureBuilt(): void {
  const stale = !existsSync(HUB_BIN) || newestMtime(PACKAGES_DIR) > statSync(HUB_BIN).mtimeMs
  if (!stale) return
  console.log('  … building hub bundle (bin missing or stale)')
  execFileSync('node', ['build.mjs'], { cwd: HUB_DIR, stdio: 'inherit' })
  if (!existsSync(HUB_BIN)) throw new Error(`hub build did not produce ${HUB_BIN}`)
}

function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null || /^(SLAYZONE_|ELECTRON_)/.test(k)) continue
    out[k] = v
  }
  return out
}

interface Hub {
  logs: string[]
  port: number
  stop: () => Promise<void>
}

async function poll<T>(fn: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v != null) return v
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function bootHub(root: string, env: Record<string, string>): Promise<Hub> {
  const logs: string[] = []
  // stdin held open: a hub started by the desktop app treats stdin EOF as "parent died".
  const proc: ChildProcess = spawn(ELECTRON_BIN, [HUB_BIN], {
    cwd: root,
    env: { ...scrubbedEnv(), ...env, SLAYZONE_ROOT: root, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const cap = (b: Buffer): void => {
    for (const line of b.toString().split('\n')) if (line.trim()) logs.push(line)
  }
  proc.stdout?.on('data', cap)
  proc.stderr?.on('data', cap)
  const stop = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      const t = setTimeout(() => proc.kill('SIGKILL'), 5_000)
      proc.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      proc.kill('SIGTERM')
    })
  try {
    const line = await poll(
      async () => logs.find((l) => l.includes('listening on http://')) ?? null,
      40_000,
      `hub listening line (logs:\n${logs.join('\n')})`
    )
    const m = line.match(/http:\/\/([^:]+):(\d+)/)
    assert(m, `listening line parseable: ${line}`)
    const port = Number(m[2])
    await poll(
      async () => {
        const r = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(1000)
        })
        return r.ok ? true : null
      },
      15_000,
      'hub /health ok'
    )
    return { logs, port, stop }
  } catch (err) {
    await stop()
    throw err
  }
}

/** A v168 database — the schema before ownership — with a hub's worth of data. */
function seedV168(root: string): void {
  const db = new Database(join(root, DB_FILE))
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    for (const m of migrations) {
      if (m.version > 168) break
      db.transaction(() => {
        m.up(db)
        db.pragma(`user_version = ${m.version}`)
      })()
    }
    db.prepare(
      `INSERT INTO projects (id, name, color, sort_order) VALUES
         ('legacy-a', 'Legacy A', '#111111', 0),
         ('legacy-b', 'Legacy B', '#222222', 1)`
    ).run()
    // `scratch` is a temporary task untouched for days: the boot purge deletes it
    // unless a persisted viewState still has it open — which this one does, so it
    // must survive the upgrade whether that state stays global or moves to a user.
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, status, priority, is_temporary, created_at, updated_at) VALUES
         ('task-a', 'legacy-a', 'Old task', 'todo', 3, 0, datetime('now'), datetime('now')),
         ('scratch', 'legacy-b', 'Scratch', 'in_progress', 3, 1,
          datetime('now', '-3 days'), datetime('now', '-3 days'))`
    ).run()
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('viewState', ?)`).run(
      JSON.stringify({ tabs: [{ type: 'task', taskId: 'scratch', title: 'Scratch' }] })
    )
  } finally {
    db.close()
  }
}

/** Read the hub's database after it stopped. */
function readDb<T>(root: string, fn: (db: Database.Database) => T): T {
  const db = new Database(join(root, DB_FILE), { readonly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

const roots: string[] = []
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'slz-ownership-boot-'))
  roots.push(root)
  return root
}

async function createProject(
  port: number,
  name: string,
  bearer?: string
): Promise<{ status: number; data?: { id: string; owner_user_id: string | null } }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    body: JSON.stringify({ name })
  })
  const body = (await res.json().catch(() => ({}))) as {
    data?: { id: string; owner_user_id: string | null }
  }
  return { status: res.status, data: body.data }
}

async function main(): Promise<void> {
  console.log('\nproject ownership at boot, through the real built hub\n')
  ensureBuilt()
  const LOOP = { SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0' }

  try {
    await test('login off (the desktop app’s hub): upgrade assigns nobody, everything works as before', async () => {
      const root = newRoot()
      seedV168(root)
      const hub = await bootHub(root, {
        ...LOOP,
        SLAYZONE_SUPERVISED: '1',
        SLAYZONE_HUB_REQUIRE_LOGIN: '0'
      })
      let createdId = ''
      try {
        const created = await createProject(hub.port, 'Desktop new')
        assert(created.status === 200 && created.data, `create → 200, got ${created.status}`)
        assert(created.data.owner_user_id === null, 'no user on the request → no owner')
        createdId = created.data.id
        const list = (await (await fetch(`http://127.0.0.1:${hub.port}/api/projects`)).json()) as {
          data: { name: string }[]
        }
        const names = list.data.map((p) => p.name).sort()
        assert(
          JSON.stringify(names) === JSON.stringify(['Desktop new', 'Legacy A', 'Legacy B']),
          `every project lists, unfiltered: ${names}`
        )
        assert(
          !hub.logs.some((l) => l.includes('"project.owner.backfill"')),
          'no backfill without login'
        )
      } finally {
        await hub.stop()
      }
      readDb(root, (db) => {
        const owners = db.prepare('SELECT id, owner_user_id FROM projects ORDER BY id').all() as {
          id: string
          owner_user_id: string | null
        }[]
        assert(owners.length === 3, `3 projects, got ${owners.length}`)
        assert(
          owners.every((o) => o.owner_user_id === null),
          `all unowned: ${JSON.stringify(owners)}`
        )
        assert(
          owners.some((o) => o.id === createdId),
          'the new project persisted'
        )
        const vs = db.prepare(`SELECT value FROM settings WHERE key = 'viewState'`).get()
        assert(vs, 'viewState stays in the global table')
        const n = (db.prepare('SELECT count(*) AS n FROM user_settings').get() as { n: number }).n
        assert(n === 0, 'no per-user settings')
        const scratch = db.prepare(`SELECT id FROM tasks WHERE id = 'scratch'`).get()
        assert(scratch, 'the open temporary task survived the boot purge')
      })
    })

    await test('login on: after boot every existing project belongs to the first admin; REST stamps the creator', async () => {
      const root = newRoot()
      seedV168(root)
      const secret = 'ownership-boot-test-signing-secret-0123456789'
      const hub = await bootHub(root, {
        ...LOOP,
        SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com',
        SLAYZONE_HUB_REQUIRE_LOGIN: '1',
        SLAYZONE_HUB_AUTH_SECRET: secret
      })
      let ownerId = ''
      let createdId = ''
      try {
        // A reachable hub keeps no owner file (T-11): the owner signs in with the
        // password derived from the secret.
        const res = await fetch(`http://127.0.0.1:${hub.port}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://hub.example.com' },
          body: JSON.stringify({
            email: BOOTSTRAP_OWNER_EMAIL,
            password: deriveBootstrapOwnerPassword(secret)
          })
        })
        const owner = {
          userId: ((await res.json()) as { user?: { id?: string } }).user?.id ?? '',
          token: res.headers.get('set-auth-token') ?? ''
        }
        ownerId = owner.userId
        assert(ownerId && owner.token, `bootstrap owner provisioned, sign-in ${res.status}`)

        const audit = hub.logs
          .filter((l) => l.startsWith('{"type":"security"'))
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .filter((e) => e.event === 'project.owner.backfill')
        assert(audit.length === 1, `one backfill audit line, got ${audit.length}`)
        assert(audit[0]!.targetId === ownerId, 'to the bootstrap owner (the first admin)')
        const detail = audit[0]!.detail as { projectCount: number; settingCount: number }
        assert(detail.projectCount === 2, `projectCount ${detail.projectCount}`)
        assert(detail.settingCount === 1, `settingCount ${detail.settingCount}`)

        const anon = await createProject(hub.port, 'No bearer')
        assert(anon.status === 401, `no bearer → 401, got ${anon.status}`)
        const created = await createProject(hub.port, 'Owner new', owner.token)
        assert(created.status === 200 && created.data, `create → 200, got ${created.status}`)
        assert(created.data.owner_user_id === ownerId, 'the creator owns it')
        createdId = created.data.id
      } finally {
        await hub.stop()
      }
      readDb(root, (db) => {
        const owners = Object.fromEntries(
          (
            db.prepare('SELECT id, owner_user_id FROM projects').all() as {
              id: string
              owner_user_id: string | null
            }[]
          ).map((r) => [r.id, r.owner_user_id])
        )
        assert(owners['legacy-a'] === ownerId, `legacy-a → admin: ${owners['legacy-a']}`)
        assert(owners['legacy-b'] === ownerId, `legacy-b → admin: ${owners['legacy-b']}`)
        assert(owners[createdId] === ownerId, 'the REST-created project')
        assert(Object.keys(owners).length === 3, 'nothing lost, nothing extra')
        const tasks = (
          db.prepare('SELECT id FROM tasks ORDER BY id').all() as { id: string }[]
        ).map((r) => r.id)
        assert(JSON.stringify(tasks) === JSON.stringify(['scratch', 'task-a']), `tasks: ${tasks}`)
        const globalVs = db.prepare(`SELECT value FROM settings WHERE key = 'viewState'`).get()
        assert(!globalVs, 'the pre-login viewState left the global table')
        const mine = db
          .prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'viewState'`)
          .get(ownerId) as { value: string } | undefined
        assert(mine?.value.includes('scratch'), 'the first admin adopted it')
      })
    })
  } finally {
    for (const r of roots) rmSync(r, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
