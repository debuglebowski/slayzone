/**
 * v169 (T-16): `projects.owner_user_id` + `user_settings`, on an empty database and
 * on a populated v168 one. The populated case is the desktop-hub upgrade: every
 * project, task, tab and setting survives untouched, and every project comes out
 * with NO owner — the migration cannot see the users. Assigning them is the hub's
 * boot step (apps/hub ownership-backfill.test.ts / ownership-boot.test.ts).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --experimental-loader ./packages/shared/test-utils/loader.ts \
 *   packages/shared/transport/src/db-bootstrap/v169-ownership-migration.test.ts
 */
import Database from 'better-sqlite3'
import { settingScope } from '@slayzone/settings/server'
import { bootstrapSchema, LATEST_MIGRATION_VERSION, migrations, runMigrations } from './index'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    failed++
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

function dbUpTo(maxVersion: number): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of migrations) {
    if (m.version > maxVersion) break
    db.transaction(() => {
      m.up(db)
      db.pragma(`user_version = ${m.version}`)
    })()
  }
  return db
}

const columns = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

/** Every row of a table, deterministic, for before/after equality. */
const dump = (db: Database.Database, table: string, order: string): unknown[] =>
  db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()

async function main(): Promise<void> {
  console.log('\nv169 project ownership + per-user settings migration')

  await test('is the latest migration, after v168', () => {
    assert(
      migrations.some((m) => m.version === 169),
      'v169 exists'
    )
    assert(LATEST_MIGRATION_VERSION >= 169, `latest ${LATEST_MIGRATION_VERSION}`)
    const versions = migrations.map((m) => m.version)
    assert(versions.indexOf(169) === versions.indexOf(168) + 1, 'v169 directly follows v168')
  })

  await test('empty DB: owner column, user_settings table, indexes', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      assert(db.pragma('user_version', { simple: true }) === LATEST_MIGRATION_VERSION, 'version')
      assert(columns(db, 'projects').includes('owner_user_id'), 'projects.owner_user_id')
      assert(
        JSON.stringify(columns(db, 'user_settings')) ===
          JSON.stringify(['user_id', 'key', 'value']),
        `user_settings columns: ${columns(db, 'user_settings')}`
      )
      const indexes = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as {
          name: string
        }[]
      ).map((r) => r.name)
      assert(indexes.includes('idx_projects_owner_user_id'), 'owner index')
      assert(indexes.includes('idx_user_settings_key'), 'user_settings key index')
      // One row per (user, key): a second write for the same pair must replace.
      db.prepare(`INSERT INTO user_settings VALUES ('u1', 'viewState', 'a')`).run()
      db.prepare(`INSERT INTO user_settings VALUES ('u2', 'viewState', 'b')`).run()
      let dup = false
      try {
        db.prepare(`INSERT INTO user_settings VALUES ('u1', 'viewState', 'c')`).run()
      } catch {
        dup = true
      }
      assert(dup, '(user_id, key) is the primary key')
    } finally {
      db.close()
    }
  })

  await test('populated v168 DB: nothing lost, every project unowned, settings untouched', () => {
    const db = dbUpTo(168)
    try {
      db.prepare(
        `INSERT INTO projects (id, name, color, path, sort_order) VALUES
           ('p1', 'Alpha', '#111111', '/tmp/alpha', 0),
           ('p2', 'Beta',  '#222222', NULL,         1)`
      ).run()
      db.prepare(
        `INSERT INTO tasks (id, project_id, title, status, priority, is_temporary) VALUES
           ('t1', 'p1', 'Task one', 'todo', 3, 0),
           ('t2', 'p2', 'Scratch',  'in_progress', 3, 1)`
      ).run()
      db.prepare(
        `INSERT INTO terminal_tabs (id, task_id, label, mode, is_main) VALUES ('t1', 't1', 'Main', 'claude-code', 1)`
      ).run()
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(
        'viewState',
        JSON.stringify({ tabs: [{ type: 'task', taskId: 't2', title: 'Scratch' }] })
      )
      const before = {
        projects: dump(db, 'projects', 'id'),
        tasks: dump(db, 'tasks', 'id'),
        tabs: dump(db, 'terminal_tabs', 'id'),
        settings: dump(db, 'settings', 'key')
      }

      runMigrations(db)

      assert(db.pragma('user_version', { simple: true }) === LATEST_MIGRATION_VERSION, 'version')
      const projects = dump(db, 'projects', 'id') as Record<string, unknown>[]
      assert(projects.length === 2, `2 projects, got ${projects.length}`)
      assert(
        projects.every((p) => p.owner_user_id === null),
        'every pre-existing project is unowned'
      )
      // Every pre-existing column value is byte-identical; the only change is the
      // new column.
      const stripped = projects.map(({ owner_user_id: _o, ...rest }) => rest)
      assert(JSON.stringify(stripped) === JSON.stringify(before.projects), 'project rows unchanged')
      assert(JSON.stringify(dump(db, 'tasks', 'id')) === JSON.stringify(before.tasks), 'tasks')
      assert(
        JSON.stringify(dump(db, 'terminal_tabs', 'id')) === JSON.stringify(before.tabs),
        'terminal tabs'
      )
      assert(
        JSON.stringify(dump(db, 'settings', 'key')) === JSON.stringify(before.settings),
        'settings unchanged (viewState stays global; the hub moves it at boot, not the migration)'
      )
      const n = (db.prepare('SELECT count(*) AS n FROM user_settings').get() as { n: number }).n
      assert(n === 0, 'user_settings starts empty')
    } finally {
      db.close()
    }
  })

  await test('every settings row a fresh database is seeded with is a hub key', () => {
    // A seeded per-user key would not be a default for everyone on a login hub:
    // users never fall back to a global row, and the boot backfill hands it to the
    // first admin. Seed per-user defaults in the client instead.
    const db = new Database(':memory:')
    try {
      bootstrapSchema(db)
      const keys = (db.prepare('SELECT key FROM settings').all() as { key: string }[]).map(
        (r) => r.key
      )
      assert(keys.length > 0, 'something is seeded')
      const notHub = keys.filter((k) => settingScope(k) !== 'hub')
      assert(notHub.length === 0, `seeded keys that are not hub-scoped: ${notHub.join(', ')}`)
    } finally {
      db.close()
    }
  })

  await test('a project created after the migration can carry an owner', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      db.prepare(
        `INSERT INTO projects (id, name, color, owner_user_id) VALUES ('p', 'P', '#000', 'user-a')`
      ).run()
      const row = db.prepare(`SELECT owner_user_id FROM projects WHERE id = 'p'`).get() as {
        owner_user_id: string
      }
      assert(row.owner_user_id === 'user-a', 'owner stored')
    } finally {
      db.close()
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
