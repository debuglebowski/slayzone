/**
 * v209: usage-log read offsets live on the computer that reads the logs (robustness
 * plan §9, P0). The hub's `usage_parse_state` becomes `usage_cursor_handoff`: each
 * computer's rows (and the hub-disk rows, computer_id '', for the hub machine's
 * own computer) are handed to it once with its next collect, then the hub drops the
 * table when it is empty (usage-analytics cache.ts). The dead pid columns go too:
 * `processes.pid` and `process_pids` have had no writer since runs live on computers.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v209-usage-cursors-to-computer-migration.test.ts
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

const tables = (db: Database.Database) =>
  new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
  )

test('stages usage cursors for their computers and drops the dead pid columns', () => {
  const db = new Database(':memory:')
  try {
    runRange(db, 0, 208)
    db.exec(`
      INSERT INTO projects (id, name, color) VALUES ('p', 'P', '#000');
      INSERT INTO tasks (id, project_id, title) VALUES ('t', 'p', 'T');
      INSERT INTO processes (id, task_id, project_id, label, command, cwd, auto_restart, pid)
        VALUES ('pr', 't', 'p', 'dev', 'npm run dev', '/w', 1, 4242);
      INSERT INTO process_pids (process_id, pid) VALUES ('pr', 4242);
      INSERT INTO usage_parse_state (computer_id, file_path, last_offset, last_modified_ms)
        VALUES ('pc', '/h/.claude/projects/a.jsonl', 100, 10), ('', '/h/.codex/b.jsonl', 7, 3);
    `)
    runRange(db, 208, 209)
    const after = tables(db)
    expect(after.has('usage_parse_state')).toBe(false)
    expect(after.has('process_pids')).toBe(false)
    expect(
      db
        .prepare(
          'SELECT computer_id, file_path, last_offset, last_modified_ms FROM usage_cursor_handoff ORDER BY computer_id'
        )
        .all()
    ).toEqual([
      { computer_id: '', file_path: '/h/.codex/b.jsonl', last_offset: 7, last_modified_ms: 3 },
      {
        computer_id: 'pc',
        file_path: '/h/.claude/projects/a.jsonl',
        last_offset: 100,
        last_modified_ms: 10
      }
    ])
    const cols = (db.prepare('PRAGMA table_info(processes)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    expect(cols).not.toContain('pid')
    // The process definition itself is hub data and stays.
    expect(db.prepare('SELECT label, command, auto_restart FROM processes').all()).toEqual([
      { label: 'dev', command: 'npm run dev', auto_restart: 1 }
    ])
    // Deleting the task still works (no trigger names the dropped column/table).
    db.exec("DELETE FROM tasks WHERE id='t'")
  } finally {
    db.close()
  }
})
