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
 * Native ABI: better-sqlite3 needs Electron's node.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/ownership-boot.test.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterAll, assert, beforeAll, expect, test } from 'vitest'
import { deriveBootstrapOwnerPassword } from '@slayzone/platform/hub-auth-secret'
import { BOOTSTRAP_OWNER_EMAIL } from '@slayzone/platform/hub-owner-file'
import { migrations } from '../../../shared/db-migrations/src/index.js'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const PACKAGES_DIR = join(HUB_DIR, '..', '..')
const ELECTRON_BIN = require('electron') as unknown as string
const DB_FILE = 'slayzone.data.sqlite'

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

beforeAll(() => ensureBuilt())
const LOOP = { SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0' }

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

test('login off (the desktop app’s hub): upgrade assigns nobody, everything works as before', async () => {
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
    expect(created.status, `create → 200, got ${created.status}`).toBe(200)
    assert(created.data, `create → 200, got ${created.status}`)
    expect(created.data.owner_user_id, 'no user on the request → no owner').toBe(null)
    createdId = created.data.id
    const list = (await (await fetch(`http://127.0.0.1:${hub.port}/api/projects`)).json()) as {
      data: { name: string }[]
    }
    const names = list.data.map((p) => p.name).sort()
    // every project lists, unfiltered
    expect(names).toEqual(['Desktop new', 'Legacy A', 'Legacy B'])
    expect(
      hub.logs.some((l) => l.includes('"project.owner.backfill"')),
      'no backfill without login'
    ).toBe(false)
  } finally {
    await hub.stop()
  }
  readDb(root, (db) => {
    const owners = db.prepare('SELECT id, owner_user_id FROM projects ORDER BY id').all() as {
      id: string
      owner_user_id: string | null
    }[]
    expect(owners, `3 projects, got ${owners.length}`).toHaveLength(3)
    // all unowned
    expect(owners.map((o) => o.owner_user_id)).toEqual([null, null, null])
    // the new project persisted
    expect(owners.map((o) => o.id)).toContain(createdId)
    const vs = db.prepare(`SELECT value FROM settings WHERE key = 'viewState'`).get()
    expect(vs, 'viewState stays in the global table').toBeTruthy()
    const n = (db.prepare('SELECT count(*) AS n FROM user_settings').get() as { n: number }).n
    expect(n, 'no per-user settings').toBe(0)
    const scratch = db.prepare(`SELECT id FROM tasks WHERE id = 'scratch'`).get()
    expect(scratch, 'the open temporary task survived the boot purge').toBeTruthy()
  })
})

test('login on: after boot every existing project belongs to the first admin; REST stamps the creator', async () => {
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
    expect(ownerId, `bootstrap owner provisioned, sign-in ${res.status}`).not.toBe('')
    expect(owner.token, `bootstrap owner provisioned, sign-in ${res.status}`).not.toBe('')

    const audit = hub.logs
      .filter((l) => l.startsWith('{"type":"security"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.event === 'project.owner.backfill')
    expect(audit, `one backfill audit line, got ${audit.length}`).toHaveLength(1)
    expect(audit[0]!.targetId, 'to the bootstrap owner (the first admin)').toBe(ownerId)
    const detail = audit[0]!.detail as { projectCount: number; settingCount: number }
    expect(detail.projectCount, `projectCount ${detail.projectCount}`).toBe(2)
    expect(detail.settingCount, `settingCount ${detail.settingCount}`).toBe(1)

    const anon = await createProject(hub.port, 'No bearer')
    expect(anon.status, `no bearer → 401, got ${anon.status}`).toBe(401)
    const created = await createProject(hub.port, 'Owner new', owner.token)
    expect(created.status, `create → 200, got ${created.status}`).toBe(200)
    assert(created.data, `create → 200, got ${created.status}`)
    expect(created.data.owner_user_id, 'the creator owns it').toBe(ownerId)
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
    expect(owners['legacy-a'], `legacy-a → admin: ${owners['legacy-a']}`).toBe(ownerId)
    expect(owners['legacy-b'], `legacy-b → admin: ${owners['legacy-b']}`).toBe(ownerId)
    expect(owners[createdId], 'the REST-created project').toBe(ownerId)
    expect(Object.keys(owners), 'nothing lost, nothing extra').toHaveLength(3)
    const tasks = (db.prepare('SELECT id FROM tasks ORDER BY id').all() as { id: string }[]).map(
      (r) => r.id
    )
    expect(tasks).toEqual(['scratch', 'task-a'])
    const globalVs = db.prepare(`SELECT value FROM settings WHERE key = 'viewState'`).get()
    expect(globalVs, 'the pre-login viewState left the global table').toBeUndefined()
    const mine = db
      .prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'viewState'`)
      .get(ownerId) as { value: string } | undefined
    expect(mine?.value, 'the first admin adopted it').toContain('scratch')
  })
})
