/**
 * v207: a task's prompt history (`agent_prompts`) and turn snapshots (`agent_turns`)
 * move to the computer running its agents (robustness plan §9, P0). Existing rows
 * are staged for that computer (`computer_data_handoff`), then both hub tables go.
 * A turn whose task the hub deleted (task_id NULL) still belongs to its checkout's
 * history: it is staged under a live task with turns in the same checkout, else it
 * goes. Erased tasks' rows are not staged.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v207-prompts-turns-to-computer-migration.test.ts
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

test('stages prompts and turns for the computer and drops both hub tables', () => {
  const db = new Database(':memory:')
  try {
    runRange(db, 0, 206)
    db.exec(`
      INSERT INTO projects (id, name, color) VALUES ('p', 'P', '#000');
      INSERT INTO tasks (id, project_id, title) VALUES ('t', 'p', 'T'), ('lonely', 'p', 'L'), ('erased', 'p', 'E');
      INSERT INTO agent_prompts (id, task_id, agent_id, cli_session_id, text, created_at)
        VALUES ('p1', 't', 'claude-code', 'sess', 'hello', 3),
               ('p2', 't', 'codex', NULL, 'bye', 4),
               ('pe', 'erased', 'claude-code', NULL, 'gone', 1);
      INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, head_sha_at_snap, prompt_preview, created_at)
        VALUES ('tr1', '/w', 't', 't', 's1', 'h1', 'fix it', 10),
               ('tr2', '/w', NULL, 'gone-tab', 's2', NULL, '', 11),
               ('tr3', '/elsewhere', NULL, 'gone-tab', 's3', 'h', '', 12),
               ('tre', '/x', 'erased', 'erased', 's4', 'h', '', 13);
    `)
    // An erased task: its fences refuse writes, and nothing could use its rows.
    db.exec(`INSERT INTO content_erasure_jobs (id, scope, manifest) VALUES ('job', 'task', '{}')`)
    db.exec(`INSERT INTO content_erasure_tasks (task_id, job_id) VALUES ('erased', 'job')`)
    runRange(db, 206, 207)

    const staged = db
      .prepare(
        'SELECT kind, item_key, task_id, payload FROM computer_data_handoff ORDER BY kind, item_key'
      )
      .all() as Array<{ kind: string; item_key: string; task_id: string; payload: string }>
    expect(
      staged.map((r) => ({
        kind: r.kind,
        key: r.item_key,
        task: r.task_id,
        v: JSON.parse(r.payload)
      }))
    ).toEqual([
      {
        kind: 'agent-prompt',
        key: 'p1',
        task: 't',
        v: { id: 'p1', agentId: 'claude-code', cliSessionId: 'sess', text: 'hello', createdAt: 3 }
      },
      {
        kind: 'agent-prompt',
        key: 'p2',
        task: 't',
        v: { id: 'p2', agentId: 'codex', cliSessionId: null, text: 'bye', createdAt: 4 }
      },
      {
        kind: 'agent-turn',
        key: 'tr1',
        task: 't',
        v: {
          id: 'tr1',
          worktreePath: '/w',
          taskId: 't',
          tabId: 't',
          snapshotSha: 's1',
          headShaAtSnap: 'h1',
          promptPreview: 'fix it',
          createdAt: 10
        }
      },
      {
        // Orphan of a checkout a live task still records in: kept with that task.
        kind: 'agent-turn',
        key: 'tr2',
        task: 't',
        v: {
          id: 'tr2',
          worktreePath: '/w',
          taskId: null,
          tabId: 'gone-tab',
          snapshotSha: 's2',
          headShaAtSnap: null,
          promptPreview: '',
          createdAt: 11
        }
      }
    ])
    const after = tables(db)
    expect(after.has('agent_prompts')).toBe(false)
    expect(after.has('agent_turns')).toBe(false)
  } finally {
    db.close()
  }
})
