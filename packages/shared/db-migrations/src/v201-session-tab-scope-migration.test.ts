/**
 * v201: terminal agent sessions are scoped per tab. Every pre-existing session,
 * ledger row and reset is backfilled to the MAIN tab (tab id = task id), so a
 * migrated store behaves exactly as before; conversations of tasks that have a
 * non-main tab of the same mode are queued for the hub's one-time recovery.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/db-migrations/src/v201-session-tab-scope-migration.test.ts
 */
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { migrations } from './index'
import { staleContentErasureFences } from './content-erasure-fences'

function runRange(db: Database.Database, from: number, to: number): void {
  for (const m of migrations)
    if (m.version > from && m.version <= to)
      db.transaction(() => {
        m.up(db)
        db.pragma(`user_version = ${m.version}`)
      })()
}

function seed(db: Database.Database): void {
  db.exec(`
    INSERT INTO projects (id, name, color) VALUES ('p', 'P', '#000');
    INSERT INTO tasks (id, project_id, title) VALUES ('t1', 'p', 'T1'), ('t2', 'p', 'T2'), ('gone', 'p', 'G');
    INSERT INTO terminal_tabs (id, task_id, label, mode, is_main, position, group_id, created_at)
      VALUES ('t1', 't1', NULL, 'claude-code', 1, 0, 't1', '2026-01-01'),
             ('deploy', 't1', 'deploy', 'claude-code', 0, 1, 'deploy', '2026-01-01'),
             ('t2', 't2', NULL, 'claude-code', 1, 0, 't2', '2026-01-01'),
             ('sh', 't2', NULL, 'terminal', 0, 1, 'sh', '2026-01-01');
    INSERT INTO agent_sessions (id, mode, task_id, conversation_id, origin, status, created_at, bound_at, tab_id)
      VALUES ('a1', 'claude-code', 't1', 'C1', 'slay-spawned-fresh', 'dead', 1, 1, NULL),
             ('a2', 'claude-code', 't2', 'C2', 'slay-spawned-fresh', 'dead', 2, 2, NULL),
             ('a3', 'claude-code', 't1', 'C3', 'slay-spawned-fresh', 'dead', 3, 3, 'deploy'),
             ('pool', 'claude-code', NULL, 'P', 'pending-spawn', 'pooled', 4, NULL, NULL),
             ('a4', 'claude-code', 'gone', 'G1', 'slay-spawned-fresh', 'dead', 5, 5, NULL);
    INSERT INTO task_conversations (id, task_id, mode, conversation_id, origin, created_at)
      VALUES ('a1', 't1', 'claude-code', 'C1', 'slay-spawned-fresh', 1);
    INSERT INTO session_resets (id, task_id, mode, created_at) VALUES ('r1', 't1', 'claude-code', 10);
    INSERT INTO content_erasure_jobs (id, scope, manifest) VALUES ('j', 'task', '{}');
    INSERT INTO content_erasure_tasks (task_id, job_id) VALUES ('gone', 'j');
  `)
}

test('backfills every task-scoped row to the main tab and queues same-mode multi-tab tasks', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  try {
    runRange(db, 0, 200)
    seed(db)
    runRange(db, 200, 201)

    const tabOf = (table: string, id: string) =>
      (db.prepare(`SELECT tab_id FROM ${table} WHERE id = ?`).get(id) as { tab_id: string | null })
        .tab_id
    expect(tabOf('agent_sessions', 'a1')).toBe('t1')
    expect(tabOf('agent_sessions', 'a2')).toBe('t2')
    // An already-attributed row (warm-pool adoption) keeps its tab.
    expect(tabOf('agent_sessions', 'a3')).toBe('deploy')
    // A pooled row has no task, so no tab.
    expect(tabOf('agent_sessions', 'pool')).toBeNull()
    // Erased content is left alone (its fence aborts writes).
    expect(tabOf('agent_sessions', 'a4')).toBeNull()
    expect(tabOf('task_conversations', 'a1')).toBe('t1')
    expect(tabOf('session_resets', 'r1')).toBe('t1')

    // Only t1 has a non-main claude-code tab; t2's extra tab is a plain shell.
    const queued = db
      .prepare(
        'SELECT task_id, mode, conversation_id FROM session_tab_recovery ORDER BY conversation_id'
      )
      .all()
    expect(queued).toEqual([
      { task_id: 't1', mode: 'claude-code', conversation_id: 'C1' },
      { task_id: 't1', mode: 'claude-code', conversation_id: 'C3' }
    ])

    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(indexes).toContain('session_resets_lookup')
    expect(indexes).toContain('agent_sessions_task_tab')
    expect(staleContentErasureFences(db)).toEqual([])

    // The work list dies with its task.
    db.prepare("DELETE FROM tasks WHERE id = 't1'").run()
    expect(db.prepare('SELECT count(*) AS n FROM session_tab_recovery').get()).toEqual({ n: 0 })
  } finally {
    db.close()
  }
})
