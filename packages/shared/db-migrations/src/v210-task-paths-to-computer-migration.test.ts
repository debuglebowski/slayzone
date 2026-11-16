/**
 * v210: a task's worktree path and base dir live on its computer (robustness plan §9,
 * P0; Phase 7a). Every task holding either is staged once in `computer_data_handoff`
 * (kind `task-path`, keyed by task) for its worktree computer, else its task
 * computer. The hub columns stay until Phase 7e: until then they are the hub's
 * authorization input, written alongside the computer's row.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v210-task-paths-to-computer-migration.test.ts
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

test('stages every task path for its computer; columns stay', () => {
  const db = new Database(':memory:')
  try {
    runRange(db, 0, 209)
    db.exec(`
      INSERT INTO projects (id, name, color) VALUES ('p', 'P', '#000');
      INSERT INTO tasks (id, project_id, title, worktree_path, base_dir)
        VALUES ('w', 'p', 'W', '/repo-workspaces/feat', NULL),
               ('b', 'p', 'B', NULL, '/custom/dir'),
               ('both', 'p', 'Both', '/repo-workspaces/x', '/d'),
               ('none', 'p', 'None', NULL, NULL),
               ('erased', 'p', 'E', '/repo-workspaces/gone', NULL);
      INSERT INTO content_erasure_jobs (id, scope, manifest, db_erased) VALUES ('job', '{}', '{}', 0);
      INSERT INTO content_erasure_tasks (task_id, job_id) VALUES ('erased', 'job');
    `)
    runRange(db, 209, 210)
    const rows = db
      .prepare(
        "SELECT item_key, task_id, payload FROM computer_data_handoff WHERE kind='task-path' ORDER BY item_key"
      )
      .all() as Array<{ item_key: string; task_id: string; payload: string }>
    expect(rows.map((r) => r.item_key)).toEqual(['b', 'both', 'w'])
    for (const r of rows) expect(r.task_id).toBe(r.item_key)
    const byKey = Object.fromEntries(rows.map((r) => [r.item_key, JSON.parse(r.payload)]))
    expect(byKey.w).toMatchObject({
      projectId: 'p',
      worktreePath: '/repo-workspaces/feat',
      baseDir: null
    })
    expect(byKey.b).toMatchObject({ projectId: 'p', worktreePath: null, baseDir: '/custom/dir' })
    expect(byKey.both).toMatchObject({ worktreePath: '/repo-workspaces/x', baseDir: '/d' })
    expect(typeof byKey.w.at).toBe('number')
    // The hub columns remain (authorization input until Phase 7e).
    expect(db.prepare("SELECT worktree_path FROM tasks WHERE id='w'").get()).toEqual({
      worktree_path: '/repo-workspaces/feat'
    })
  } finally {
    db.close()
  }
})

test("a path cleared to '' is unset: never staged as '' (p10-v0380-worktrees)", () => {
  const db = new Database(':memory:')
  try {
    runRange(db, 0, 209)
    db.exec(`
      INSERT INTO projects (id, name, color) VALUES ('p', 'P', '#000');
      INSERT INTO tasks (id, project_id, title, worktree_path, base_dir)
        VALUES ('both', 'p', 'Both cleared', '', ''),
               ('wt', 'p', 'Worktree cleared', '', '/custom/dir'),
               ('bd', 'p', 'Base dir cleared', '/repo-workspaces/x', '');
    `)
    runRange(db, 209, 210)
    const staged = Object.fromEntries(
      (
        db
          .prepare("SELECT item_key, payload FROM computer_data_handoff WHERE kind='task-path'")
          .all() as Array<{ item_key: string; payload: string }>
      ).map((r) => [r.item_key, JSON.parse(r.payload)])
    )
    // Nothing set: nothing to hand over.
    expect(Object.keys(staged).sort()).toEqual(['bd', 'wt'])
    expect(staged.wt).toMatchObject({ worktreePath: null, baseDir: '/custom/dir' })
    expect(staged.bd).toMatchObject({ worktreePath: '/repo-workspaces/x', baseDir: null })
  } finally {
    db.close()
  }
})
