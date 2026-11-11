/**
 * v211: the hub keeps no task path (robustness plan §9, P0; Phase 7e). The worktree
 * path and base dir live only on the computer holding the task's folders
 * (`tasks.worktree_computer_id`), which v210 handed them to. The hub keeps whether
 * each is set (`has_worktree`, `has_base_dir`) and which computer holds them.
 *
 * - Every task holding a path is staged once more with `at` 0: a computer that
 *   already holds the row keeps it (newer), one that lost or never took it gets it.
 *   A row still pending keeps its own (newer) value.
 * - A task holding a path with no recorded folder computer gets its task's (or
 *   project's) computer: its folders are where its work ran.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v211-drop-hub-task-paths-migration.test.ts
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

const columns = (db: Database.Database) =>
  (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name)

test('drops the path columns, keeps has-flags and the folder computer', () => {
  const db = new Database(':memory:')
  try {
    runRange(db, 0, 210)
    db.exec(`
      INSERT INTO computers (id, name, platform, version, capabilities_json, created_at)
        VALUES ('c1', 'C1', 'darwin', '1', '[]', 0), ('c2', 'C2', 'darwin', '1', '[]', 0);
      INSERT INTO projects (id, name, color, default_computer_id) VALUES ('p', 'P', '#000', 'c2');
      INSERT INTO tasks (id, project_id, title, worktree_path, base_dir, computer_id, worktree_computer_id)
        VALUES ('w', 'p', 'W', '/repo-workspaces/feat', NULL, NULL, 'c1'),
               ('b', 'p', 'B', NULL, '/custom/dir', 'c1', NULL),
               ('legacy', 'p', 'L', '/old', NULL, NULL, NULL),
               ('none', 'p', 'None', NULL, NULL, NULL, NULL),
               ('erased', 'p', 'E', '/repo-workspaces/gone', NULL, NULL, NULL);
      INSERT INTO content_erasure_jobs (id, scope, manifest, db_erased) VALUES ('job', '{}', '{}', 0);
      INSERT INTO content_erasure_tasks (task_id, job_id) VALUES ('erased', 'job');
    `)
    // A row still pending from v210 (or a live write) keeps its own, newer value.
    db.exec(
      `INSERT INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
       VALUES('task-path','b','b',json_object('projectId','p','worktreePath',NULL,'baseDir','/newer','at',99),99)`
    )
    runRange(db, 210, 211)

    const cols = columns(db)
    expect(cols).not.toContain('worktree_path')
    expect(cols).not.toContain('base_dir')
    expect(cols).toContain('has_worktree')
    expect(cols).toContain('has_base_dir')
    expect(cols).toContain('worktree_computer_id')

    const flags = Object.fromEntries(
      (
        db
          .prepare('SELECT id, has_worktree, has_base_dir, worktree_computer_id FROM tasks')
          .all() as Array<{
          id: string
          has_worktree: number
          has_base_dir: number
          worktree_computer_id: string | null
        }>
      ).map((r) => [r.id, r])
    )
    expect(flags.w).toMatchObject({ has_worktree: 1, has_base_dir: 0, worktree_computer_id: 'c1' })
    expect(flags.b).toMatchObject({ has_worktree: 0, has_base_dir: 1, worktree_computer_id: 'c1' })
    // No recorded folder computer: the task's computer, else its project's.
    expect(flags.legacy).toMatchObject({ has_worktree: 1, worktree_computer_id: 'c2' })
    expect(flags.none).toMatchObject({
      has_worktree: 0,
      has_base_dir: 0,
      worktree_computer_id: null
    })

    const staged = Object.fromEntries(
      (
        db
          .prepare("SELECT item_key, payload FROM computer_data_handoff WHERE kind='task-path'")
          .all() as Array<{ item_key: string; payload: string }>
      ).map((r) => [r.item_key, JSON.parse(r.payload)])
    )
    expect(Object.keys(staged).sort()).toEqual(['b', 'legacy', 'w'])
    expect(staged.w).toMatchObject({ worktreePath: '/repo-workspaces/feat', baseDir: null, at: 0 })
    expect(staged.legacy).toMatchObject({ worktreePath: '/old', at: 0 })
    // The pending row keeps its newer value.
    expect(staged.b).toMatchObject({ baseDir: '/newer', at: 99 })
  } finally {
    db.close()
  }
})

test('a subtask holding its parent’s folder gets the parent’s computer (p10-v0380-worktrees)', () => {
  const db = new Database(':memory:')
  try {
    runRange(db, 0, 210)
    db.exec(`
      INSERT INTO computers (id, name, platform, version, capabilities_json, created_at)
        VALUES ('local', 'L', 'linux', '1', '[]', 0), ('bb', 'BB', 'linux', '1', '[]', 0);
      INSERT INTO projects (id, name, color, default_computer_id) VALUES ('p', 'P', '#000', 'local');
      INSERT INTO tasks (id, project_id, title, parent_id, computer_id, worktree_path, base_dir, worktree_computer_id)
        VALUES ('pinned', 'p', 'Pinned', NULL, 'bb', '/wt/pinned', NULL, NULL),
               ('child', 'p', 'Child', 'pinned', NULL, '/wt/pinned', NULL, NULL),
               ('grandchild', 'p', 'Grandchild', 'child', NULL, '/wt/pinned', NULL, NULL),
               ('own', 'p', 'Own', 'pinned', NULL, '/wt/own', NULL, NULL),
               ('bdparent', 'p', 'BD parent', NULL, 'bb', NULL, '/api', NULL),
               ('bdchild', 'p', 'BD child', 'bdparent', NULL, '', '/api', NULL),
               ('recorded', 'p', 'Recorded', 'pinned', NULL, '/wt/pinned', NULL, 'local');
    `)
    runRange(db, 210, 211)
    const holder = (id: string) =>
      (
        db.prepare('SELECT worktree_computer_id AS c FROM tasks WHERE id=?').get(id) as {
          c: string
        }
      ).c
    expect(holder('pinned')).toBe('bb')
    expect(holder('child')).toBe('bb')
    expect(holder('grandchild')).toBe('bb')
    expect(holder('own')).toBe('local') // its own folder: its own computer, else the project's
    expect(holder('bdchild')).toBe('bb') // '' is unset: the same folders as its parent
    expect(holder('recorded')).toBe('local') // a recorded holder is ground truth: kept
  } finally {
    db.close()
  }
})
