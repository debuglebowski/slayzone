/**
 * v171: `terminal_tabs.agent_state` replaces `was_spawned` + `hibernated`, and
 * `terminal_agent_startup` replaces `terminal_auto_start` + `terminal_prewarm_enabled`
 * (plans/agent-startup-mode.md).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/db-migrations/src/v171-agent-startup-migration.test.ts
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
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

const setting = (db: Database.Database, key: string): string | undefined =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)
    ?.value

function seedTask(db: Database.Database): void {
  db.prepare(`INSERT INTO projects (id, name, color) VALUES ('p1', 'P', '#000')`).run()
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, status) VALUES ('t1', 'p1', 'T', 'todo'),
       ('t2', 'p1', 'T2', 'todo'), ('t3', 'p1', 'T3', 'todo')`
  ).run()
}

function setOld(db: Database.Database, autoStart: string | null, prewarm: string | null): void {
  if (autoStart !== null)
    db.prepare(`INSERT INTO settings (key, value) VALUES ('terminal_auto_start', ?)`).run(autoStart)
  if (prewarm !== null)
    db.prepare(`INSERT INTO settings (key, value) VALUES ('terminal_prewarm_enabled', ?)`).run(
      prewarm
    )
}

describe('v171 agent startup mode migration', () => {
  test('tab flags become agent_state; old columns dropped', () => {
    const db = dbUpTo(170)
    seedTask(db)
    const ins = db.prepare(
      `INSERT INTO terminal_tabs (id, task_id, mode, is_main, position, group_id, created_at, was_spawned, hibernated)
       VALUES (?, ?, 'claude-code', 1, 0, ?, '2026-01-01', ?, ?)`
    )
    ins.run('t1', 't1', 't1', 1, 0)
    ins.run('t2', 't2', 't2', 0, 1)
    ins.run('t3', 't3', 't3', 0, 0)
    runMigrations(db)
    const state = (id: string) =>
      (
        db.prepare('SELECT agent_state FROM terminal_tabs WHERE id = ?').get(id) as {
          agent_state: string
        }
      ).agent_state
    expect(state('t1')).toBe('running')
    expect(state('t2')).toBe('auto_stopped')
    expect(state('t3')).toBe('stopped')
    const cols = columns(db, 'terminal_tabs')
    expect(cols).not.toContain('was_spawned')
    expect(cols).not.toContain('hibernated')
  })

  test('new tab row defaults to stopped', () => {
    const db = dbUpTo(170)
    seedTask(db)
    runMigrations(db)
    db.prepare(
      `INSERT INTO terminal_tabs (id, task_id, mode, is_main, position, group_id, created_at)
       VALUES ('t1', 't1', 'claude-code', 1, 0, 't1', '2026-01-01')`
    ).run()
    const row = db.prepare(`SELECT agent_state FROM terminal_tabs WHERE id = 't1'`).get() as {
      agent_state: string
    }
    expect(row.agent_state).toBe('stopped')
  })

  const cases: Array<[string | null, string | null, string]> = [
    ['1', '1', 'instant'],
    ['1', '0', 'auto'],
    ['1', null, 'auto'],
    ['0', '1', 'manual'],
    ['0', null, 'manual'],
    [null, null, 'manual'],
    [null, '1', 'manual']
  ]
  for (const [autoStart, prewarm, expected] of cases) {
    test(`existing install: auto_start=${autoStart} prewarm=${prewarm} → ${expected}`, () => {
      const db = dbUpTo(170)
      seedTask(db)
      setOld(db, autoStart, prewarm)
      runMigrations(db)
      expect(setting(db, 'terminal_agent_startup')).toBe(expected)
      // old auto_start / prewarm rows removed
      expect(setting(db, 'terminal_auto_start')).toBeUndefined()
      expect(setting(db, 'terminal_prewarm_enabled')).toBeUndefined()
    })
  }

  test('login hub: auto_start on in user_settings counts', () => {
    const db = dbUpTo(170)
    seedTask(db)
    db.prepare(
      `INSERT INTO user_settings (user_id, key, value) VALUES ('u1', 'terminal_auto_start', '1')`
    ).run()
    runMigrations(db)
    expect(setting(db, 'terminal_agent_startup')).toBe('auto')
    const left = db
      .prepare(`SELECT COUNT(*) AS n FROM user_settings WHERE key = 'terminal_auto_start'`)
      .get() as {
      n: number
    }
    // user_settings row removed
    expect(left.n).toBe(0)
  })

  test('fresh install (no tasks): no row written → default auto', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    // no row
    expect(setting(db, 'terminal_agent_startup')).toBeUndefined()
  })
})
