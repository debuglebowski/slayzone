/**
 * v169 (T-16): `projects.owner_user_id` + `user_settings`, on an empty database and
 * on a populated v168 one. The populated case is the desktop-hub upgrade: every
 * project, task, tab and setting survives untouched, and every project comes out
 * with NO owner — the migration cannot see the users. Assigning them is the hub's
 * boot step (apps/hub ownership-backfill.test.ts / ownership-boot.test.ts).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/db-migrations/src/v169-ownership-migration.test.ts
 */
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { LATEST_MIGRATION_VERSION, migrations, runMigrations } from './index'

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

describe('v169 project ownership + per-user settings migration', () => {
  test('is the latest migration, after v168', () => {
    // v169 exists
    expect(migrations.map((m) => m.version)).toContain(169)
    expect(LATEST_MIGRATION_VERSION).toBeGreaterThanOrEqual(169)
    const versions = migrations.map((m) => m.version)
    // v169 directly follows v168
    expect(versions.indexOf(169)).toBe(versions.indexOf(168) + 1)
  })

  test('empty DB: owner column, user_settings table, indexes', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      expect(db.pragma('user_version', { simple: true })).toBe(LATEST_MIGRATION_VERSION)
      expect(columns(db, 'projects')).toContain('owner_user_id')
      expect(columns(db, 'user_settings')).toEqual(['user_id', 'key', 'value'])
      const indexes = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as {
          name: string
        }[]
      ).map((r) => r.name)
      expect(indexes).toContain('idx_projects_owner_user_id')
      expect(indexes).toContain('idx_user_settings_key')
      // One row per (user, key): a second write for the same pair must replace.
      db.prepare(`INSERT INTO user_settings VALUES ('u1', 'viewState', 'a')`).run()
      db.prepare(`INSERT INTO user_settings VALUES ('u2', 'viewState', 'b')`).run()
      let dup = false
      try {
        db.prepare(`INSERT INTO user_settings VALUES ('u1', 'viewState', 'c')`).run()
      } catch {
        dup = true
      }
      // (user_id, key) is the primary key
      expect(dup).toBe(true)
    } finally {
      db.close()
    }
  })

  test('populated v168 DB: nothing lost, every project unowned, settings untouched', () => {
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

      // Up to v169 only: this pins what v169 does to a populated database, and later
      // migrations legitimately reshape these tables (v171 rewrites terminal_tabs'
      // spawn flags and seeds a startup-mode setting).
      for (const m of migrations) {
        if (m.version <= 168 || m.version > 169) continue
        db.transaction(() => {
          m.up(db)
          db.pragma(`user_version = ${m.version}`)
        })()
      }

      expect(db.pragma('user_version', { simple: true })).toBe(169)
      const projects = dump(db, 'projects', 'id') as Record<string, unknown>[]
      expect(projects).toHaveLength(2)
      // every pre-existing project is unowned
      expect(projects.map((p) => p.owner_user_id)).toEqual([null, null])
      // Every pre-existing column value is byte-identical; the only change is the
      // new column.
      const stripped = projects.map(({ owner_user_id: _o, ...rest }) => rest)
      expect(stripped).toStrictEqual(before.projects)
      expect(dump(db, 'tasks', 'id')).toStrictEqual(before.tasks)
      expect(dump(db, 'terminal_tabs', 'id')).toStrictEqual(before.tabs)
      // settings unchanged (viewState stays global; the hub moves it at boot, not the migration)
      expect(dump(db, 'settings', 'key')).toStrictEqual(before.settings)
      const n = (db.prepare('SELECT count(*) AS n FROM user_settings').get() as { n: number }).n
      // user_settings starts empty
      expect(n).toBe(0)
    } finally {
      db.close()
    }
  })

  test('a project created after the migration can carry an owner', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      db.prepare(
        `INSERT INTO projects (id, name, color, owner_user_id) VALUES ('p', 'P', '#000', 'user-a')`
      ).run()
      const row = db.prepare(`SELECT owner_user_id FROM projects WHERE id = 'p'`).get() as {
        owner_user_id: string
      }
      expect(row.owner_user_id).toBe('user-a')
    } finally {
      db.close()
    }
  })
})
