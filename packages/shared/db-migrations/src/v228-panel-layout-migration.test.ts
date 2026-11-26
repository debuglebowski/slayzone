/**
 * v228: panel model columns (docs/plans/panel-model.md §1.2) — `tasks.panel_layout`,
 * `tasks.panel_instance_state`, `task_templates.panel_layout`. No backfill: existing
 * rows keep NULL (derived on read from the legacy columns), legacy data untouched.
 *
 * Run with: ./node_modules/.bin/vitest run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v228-panel-layout-migration.test.ts
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

const columnsOf = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

test('adds the layout columns as NULL on existing rows, legacy columns kept', () => {
  const db = new Database(':memory:')
  try {
    runRange(db, 0, 226)
    db.exec(`
      INSERT INTO projects (id, name, color) VALUES ('p', 'P', '#000');
      INSERT INTO tasks (id, project_id, title, panel_visibility, panel_sizes)
        VALUES ('t', 'p', 'A', '{"browser":true}', '{"browser":{"unit":"px","value":500}}');
      INSERT INTO task_templates (id, project_id, name, panel_visibility)
        VALUES ('tpl', 'p', 'T', '{"editor":true}');
    `)
    runRange(db, 226, 228)
    expect(db.pragma('user_version', { simple: true })).toBe(228)
    expect(columnsOf(db, 'tasks')).toEqual(
      expect.arrayContaining(['panel_layout', 'panel_instance_state'])
    )
    expect(columnsOf(db, 'task_templates')).toContain('panel_layout')
    expect(
      db
        .prepare(
          "SELECT panel_layout, panel_instance_state, panel_visibility, panel_sizes FROM tasks WHERE id = 't'"
        )
        .get()
    ).toEqual({
      panel_layout: null,
      panel_instance_state: null,
      panel_visibility: '{"browser":true}',
      panel_sizes: '{"browser":{"unit":"px","value":500}}'
    })
    expect(
      db.prepare("SELECT panel_layout, panel_visibility FROM task_templates WHERE id = 'tpl'").get()
    ).toEqual({ panel_layout: null, panel_visibility: '{"editor":true}' })
  } finally {
    db.close()
  }
})
