/**
 * v226: open task tabs per user (`open_task_tabs`), the tab bar every client of a user
 * shares. Seeded from the tab layouts already saved on the hub (`viewState`: the global
 * row = user '', each `user_settings` row = its user): their task tabs whose task lives
 * on this hub, in tab-bar order. Tabs of other hubs' tasks, other tab kinds and corrupt
 * layouts seed nothing.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v226-open-task-tabs-migration.test.ts
 */
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { migrations } from './index'

function runRange(db: Database.Database, from: number, to: number): void {
  for (const m of migrations)
    if (m.version > from && m.version <= to)
      db.transaction(() => {
        m.up(db)
        db.pragma(`user_version = ${m.version}`)
      })()
}

const layout = (tabs: unknown[]) => JSON.stringify({ tabs, activeTabIndex: 0 })

test('seeds each saved layout’s task tabs of this hub, per user, in tab-bar order', () => {
  const db = new Database(':memory:')
  try {
    runRange(db, 0, 225)
    db.exec(`
      INSERT INTO projects (id, name, color) VALUES ('p', 'P', '#000');
      INSERT INTO tasks (id, project_id, title) VALUES ('t1', 'p', 'A'), ('t2', 'p', 'B'), ('t3', 'p', 'C');
    `)
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('viewState', ?)").run(
      layout([
        { type: 'home' },
        { type: 'task', taskId: 't2', title: 'B' },
        { type: 'task', taskId: 'elsewhere', title: 'other hub', hubId: 'remote' },
        { type: 'task', taskId: 't1', title: 'A' }
      ])
    )
    const perUser = db.prepare(
      "INSERT INTO user_settings (user_id, key, value) VALUES (?, 'viewState', ?)"
    )
    perUser.run('alice', layout([{ type: 'task', taskId: 't3', title: 'C' }]))
    perUser.run('bob', '{not json')
    runRange(db, 225, 226)
    expect(
      db.prepare('SELECT user_id, task_id FROM open_task_tabs ORDER BY user_id, position').all()
    ).toEqual([
      { user_id: '', task_id: 't2' },
      { user_id: '', task_id: 't1' },
      { user_id: 'alice', task_id: 't3' }
    ])
    // A deleted task takes its tab with it.
    db.pragma('foreign_keys = ON')
    db.prepare("DELETE FROM tasks WHERE id = 't2'").run()
    expect(db.prepare("SELECT task_id FROM open_task_tabs WHERE user_id = ''").all()).toEqual([
      { task_id: 't1' }
    ])
  } finally {
    db.close()
  }
})
