/**
 * v206: the agent-session ledger moves to the computer running a task's agents
 * (robustness plan §9, P0). Existing ledger rows are staged for that computer
 * (`computer_data_handoff`), the hub copies (tables, provider_config session ids,
 * legacy `*_conversation_id` columns) go, and the hub's session intent gains its
 * delivery bookkeeping (`session_resets.except_chat`, `session_intent_acks`).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v206-session-ledger-to-computer-migration.test.ts
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

test('stages the ledger for the computer and drops every hub copy', () => {
  const db = new Database(':memory:')
  try {
    runRange(db, 0, 205)
    db.exec(`INSERT INTO projects (id, name, color) VALUES ('p', 'P', '#000');`)
    db.prepare(
      'INSERT INTO tasks (id, project_id, title, provider_config, claude_conversation_id) VALUES (?,?,?,?,?)'
    ).run(
      't',
      'p',
      'T',
      JSON.stringify({
        'claude-code': { flags: '--x', conversationId: 'cur', conversationHistory: ['old', 'cur'] },
        'claude-chat': { chatModel: 'm' }
      }),
      'col'
    )
    db.prepare('INSERT INTO tasks (id, project_id, title, provider_config) VALUES (?,?,?,?)').run(
      'erased',
      'p',
      'E',
      JSON.stringify({ codex: { conversationId: 'gone' } })
    )
    db.exec(`
      INSERT INTO agent_sessions (id, mode, task_id, tab_id, conversation_id, origin, status, created_at, bound_at)
        VALUES ('s1','claude-code','t','t','cur','slay-spawned-fresh','dead',10,10),
               ('pool','claude-code',NULL,NULL,'p1','pending-spawn','pooled',5,NULL),
               ('s2','codex','erased','erased','gone','slay-spawned-fresh','dead',10,10);
      INSERT INTO task_conversations (id, task_id, mode, tab_id, conversation_id, origin, created_at)
        VALUES ('s1','t','claude-code','t','cur','slay-spawned-fresh',10);
      INSERT INTO session_turns (conversation_id, first_turn_at) VALUES ('cur', 11), ('gone', 12);
      INSERT INTO session_resets (id, task_id, mode, tab_id, created_at) VALUES ('r1','t','claude-code','t',9);
    `)
    db.exec(`INSERT INTO content_erasure_jobs (id, scope, manifest) VALUES ('job', 'task', '{}')`)
    db.exec(`INSERT INTO content_erasure_tasks (task_id, job_id) VALUES ('erased', 'job')`)

    runRange(db, 205, 206)

    const staged = db
      .prepare(
        'SELECT kind, item_key, task_id, payload FROM computer_data_handoff ORDER BY kind, item_key'
      )
      .all() as Array<{ kind: string; item_key: string; task_id: string; payload: string }>
    expect(staged.map((r) => `${r.kind}/${r.item_key}/${r.task_id}`)).toEqual([
      'agent-session/s1/t',
      'legacy-conversation-history/t:claude-code/t',
      'session-turn/t:cur/t',
      'task-conversation/s1/t'
    ])
    expect(JSON.parse(staged[0].payload)).toMatchObject({
      id: 's1',
      taskId: 't',
      tabId: 't',
      conversationId: 'cur',
      origin: 'slay-spawned-fresh',
      status: 'dead',
      createdAt: 10,
      boundAt: 10,
      endedAt: null
    })
    expect(JSON.parse(staged[1].payload)).toEqual({
      mode: 'claude-code',
      ids: ['old', 'cur', 'col']
    })
    expect(JSON.parse(staged[2].payload)).toEqual({ conversationId: 'cur', firstTurnAt: 11 })

    const t = tables(db)
    for (const gone of ['agent_sessions', 'task_conversations', 'session_turns'])
      expect(t.has(gone)).toBe(false)
    expect(t.has('session_intent_acks')).toBe(true)
    const cols = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    expect(cols.some((c) => c.endsWith('_conversation_id'))).toBe(false)
    const config = JSON.parse(
      (
        db.prepare("SELECT provider_config FROM tasks WHERE id='t'").get() as {
          provider_config: string
        }
      ).provider_config
    )
    expect(config).toEqual({ 'claude-code': { flags: '--x' }, 'claude-chat': { chatModel: 'm' } })
    expect(db.prepare("SELECT except_chat FROM session_resets WHERE id='r1'").get()).toEqual({
      except_chat: 0
    })
  } finally {
    db.close()
  }
})
