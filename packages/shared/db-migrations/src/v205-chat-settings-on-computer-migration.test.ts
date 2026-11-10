/**
 * v205: chat settings and the chat session id live only on the chat's computer
 * (robustness plan §9, decision 2). The hub's revision table goes; a task's chat
 * keys are removed for every mode whose chat a computer already owns (it holds
 * them). A chat not yet moved to a computer (legacy, or mid-migration) keeps them:
 * they seed its computer configuration when it moves. Terminal keys stay.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v205-chat-settings-on-computer-migration.test.ts
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

const chat = {
  chatMode: 'plan',
  chatModel: 'm',
  chatEffort: 'high',
  chatCollaboration: 'plan',
  chatFastMode: true,
  chatConversationId: 'C',
  flags: '--chat-flag'
}

test('drops the hub copy of chat settings for computer-owned chats only', () => {
  const db = new Database(':memory:')
  try {
    runRange(db, 0, 204)
    const config = JSON.stringify({
      'claude-chat': chat,
      'codex-chat': chat,
      'claude-code': { flags: '--t', conversationId: 'T' }
    })
    db.exec(`INSERT INTO projects (id, name, color) VALUES ('p', 'P', '#000');`)
    const task = db.prepare(
      'INSERT INTO tasks (id, project_id, title, provider_config) VALUES (?, ?, ?, ?)'
    )
    task.run('owned', 'p', 'Owned', config)
    task.run('legacy', 'p', 'Legacy', config)
    task.run('invalid', 'p', 'Invalid', 'not json')
    const owner = db.prepare(
      'INSERT INTO chat_ownership (id, task_id, tab_id, mode, computer_id, epoch, state) VALUES (?, ?, ?, ?, ?, 1, ?)'
    )
    owner.run('o1', 'owned', 'owned', 'claude-chat', 'pc', 'active')
    owner.run('o2', 'legacy', 'legacy', 'claude-chat', null, 'legacy')
    owner.run('o3', 'legacy', 'tab2', 'codex-chat', 'pc', 'copying')
    db.prepare(
      'INSERT INTO chat_provider_config_revisions (task_id, mode, revision, config_hash) VALUES (?, ?, 3, ?)'
    ).run('owned', 'claude-chat', 'h')

    runRange(db, 204, 205)

    const read = (id: string) =>
      (
        db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(id) as {
          provider_config: string
        }
      ).provider_config
    const owned = JSON.parse(read('owned'))
    // Computer-owned chat: only the hub-owned spawn flags remain.
    expect(owned['claude-chat']).toEqual({ flags: '--chat-flag' })
    // No chat of that mode on a computer yet: starting values stay.
    expect(owned['codex-chat']).toEqual(chat)
    expect(owned['claude-code']).toEqual({ flags: '--t', conversationId: 'T' })
    const legacy = JSON.parse(read('legacy'))
    expect(legacy['claude-chat']).toEqual(chat)
    expect(legacy['codex-chat']).toEqual(chat)
    expect(read('invalid')).toBe('not json')
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chat_provider_config_revisions'").get()
    ).toBeUndefined()
  } finally {
    db.close()
  }
})

// S6: a computer-owned chat's settings could exist ONLY on the hub (the prod copy had
// a chat whose computer held no provider config: its auto-accept mode was lost). The
// hub copy still goes, but first it is staged for that chat's computer, which fills
// only the settings it does not have (its own values are newer).
test('stages the stripped chat settings for the computer before dropping them', () => {
  const db = new Database(':memory:')
  try {
    runRange(db, 0, 204)
    db.exec(`INSERT INTO projects (id, name, color) VALUES ('p', 'P', '#000');`)
    db.prepare(
      'INSERT INTO tasks (id, project_id, title, provider_config) VALUES (?, ?, ?, ?)'
    ).run(
      'owned',
      'p',
      'Owned',
      JSON.stringify({
        'claude-chat': { chatMode: 'auto-accept', chatConversationId: 'C', flags: '--f' }
      })
    )
    db.prepare(
      'INSERT INTO tasks (id, project_id, title, provider_config) VALUES (?, ?, ?, ?)'
    ).run('flags-only', 'p', 'Flags', JSON.stringify({ 'claude-chat': { flags: '--f' } }))
    const owner = db.prepare(
      'INSERT INTO chat_ownership (id, task_id, tab_id, mode, computer_id, epoch, state) VALUES (?, ?, ?, ?, ?, 1, ?)'
    )
    owner.run('o1', 'owned', 'owned', 'claude-chat', 'pc', 'active')
    owner.run('o2', 'flags-only', 'flags-only', 'claude-chat', 'pc', 'active')

    runRange(db, 204, 205)

    const staged = db
      .prepare(
        'SELECT kind, item_key, task_id, payload FROM computer_data_handoff ORDER BY item_key'
      )
      .all() as Array<{ kind: string; item_key: string; task_id: string; payload: string }>
    // The settings only (a session id is the computer's ledger; flags stay on the hub).
    expect(staged.map((r) => ({ ...r, payload: JSON.parse(r.payload) }))).toEqual([
      {
        kind: 'chat-settings',
        item_key: 'owned:claude-chat',
        task_id: 'owned',
        payload: { mode: 'claude-chat', settings: { chatMode: 'auto-accept' } }
      }
    ])
  } finally {
    db.close()
  }
})
