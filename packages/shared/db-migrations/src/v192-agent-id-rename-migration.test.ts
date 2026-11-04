/**
 * v192: "terminal mode" → "agent". `terminal_modes` becomes `agents`,
 * `tasks.terminal_mode` / `task_templates.terminal_mode` become `agent_id`, and
 * the `default_terminal_mode` setting moves to `default_agent_id` — values kept.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/db-migrations/src/v192-agent-id-rename-migration.test.ts
 */
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { migrations, runMigrations } from './index'

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
  (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name)

const setting = (db: Database.Database, key: string): string | undefined =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)
    ?.value

describe('v192 agent id rename migration', () => {
  test('table, columns and setting are renamed; every value survives', () => {
    const db = dbUpTo(191)
    db.prepare(
      `INSERT INTO terminal_modes (id, label, type, initial_command, default_flags, enabled, is_builtin, "order")
       VALUES ('claude-code', 'Claude', 'claude-code', 'claude {flags}', '--verbose', 1, 1, 0),
              ('my-agent', 'Mine', 'terminal', 'mine', NULL, 0, 0, 9)`
    ).run()
    db.prepare(`INSERT INTO projects (id, name, color) VALUES ('p1', 'P', '#000')`).run()
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, status, terminal_mode) VALUES ('t1', 'p1', 'A', 'todo', 'codex')`
    ).run()
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, status) VALUES ('t2', 'p1', 'B', 'todo')`
    ).run()
    db.prepare(
      `INSERT INTO task_templates (id, project_id, name, terminal_mode) VALUES
         ('tpl1', 'p1', 'With', 'my-agent'), ('tpl2', 'p1', 'Without', NULL)`
    ).run()
    db.prepare(`INSERT INTO settings (key, value) VALUES ('default_terminal_mode', 'gemini')`).run()
    db.prepare(
      `INSERT INTO user_settings (user_id, key, value) VALUES
         ('u1', 'default_terminal_mode', 'codex'), ('u1', 'viewState', '{}')`
    ).run()

    runMigrations(db)

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
        name: string
      }>
    ).map((t) => t.name)
    expect(tables).toContain('agents')
    expect(tables).not.toContain('terminal_modes')
    expect(
      db.prepare(`SELECT id, label, default_flags, enabled, "order" FROM agents ORDER BY id`).all()
    ).toEqual([
      { id: 'claude-code', label: 'Claude', default_flags: '--verbose', enabled: 1, order: 0 },
      { id: 'my-agent', label: 'Mine', default_flags: null, enabled: 0, order: 9 }
    ])

    for (const table of ['tasks', 'task_templates']) {
      expect(columns(db, table)).toContain('agent_id')
      expect(columns(db, table)).not.toContain('terminal_mode')
    }
    expect(db.prepare(`SELECT id, agent_id FROM tasks ORDER BY id`).all()).toEqual([
      { id: 't1', agent_id: 'codex' },
      { id: 't2', agent_id: 'claude-code' }
    ])
    expect(db.prepare(`SELECT id, agent_id FROM task_templates ORDER BY id`).all()).toEqual([
      { id: 'tpl1', agent_id: 'my-agent' },
      { id: 'tpl2', agent_id: null }
    ])

    expect(setting(db, 'default_agent_id')).toBe('gemini')
    expect(setting(db, 'default_terminal_mode')).toBeUndefined()
    expect(db.prepare(`SELECT user_id, key, value FROM user_settings ORDER BY key`).all()).toEqual([
      { user_id: 'u1', key: 'default_agent_id', value: 'codex' },
      { user_id: 'u1', key: 'viewState', value: '{}' }
    ])
    db.close()
  })

  test('the column default carries over: a task inserted after the rename gets claude-code', () => {
    const db = dbUpTo(191)
    runMigrations(db)
    db.prepare(`INSERT INTO projects (id, name, color) VALUES ('p1', 'P', '#000')`).run()
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, status) VALUES ('t1', 'p1', 'A', 'todo')`
    ).run()
    expect(db.prepare(`SELECT agent_id FROM tasks WHERE id = 't1'`).get()).toEqual({
      agent_id: 'claude-code'
    })
    // The triggers on `tasks` still compile against the renamed table.
    db.prepare(`DELETE FROM tasks WHERE id = 't1'`).run()
    db.close()
  })

  test('no setting row: none is invented', () => {
    const db = dbUpTo(191)
    runMigrations(db)
    expect(setting(db, 'default_agent_id')).toBeUndefined()
    expect(setting(db, 'default_terminal_mode')).toBeUndefined()
    db.close()
  })

  test('no schema object still names the old table or column', () => {
    const db = dbUpTo(191)
    runMigrations(db)
    const stale = db
      .prepare(`SELECT type, name FROM sqlite_master WHERE sql LIKE '%terminal_mode%'`)
      .all()
    expect(stale).toEqual([])
    db.close()
  })
})
