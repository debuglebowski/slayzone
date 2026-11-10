/**
 * Phase 8 (robustness plan §9): the hub drops its legacy chat tables once this
 * install has nothing left to migrate — at boot, before any service reads them.
 */
import { expect, test } from 'vitest'
import {
  LEGACY_CHAT_TABLES,
  LEGACY_CHAT_TABLES_DROPPED_SETTING,
  legacyChatTables,
  legacyChatTablesSync
} from '@slayzone/platform/legacy-chat-tables'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { checkHubChatConsistency } from './hub-consistency'
import { settleLegacyChatTables } from './legacy-tables'

async function fixture() {
  const h = await createTestHarness()
  h.db.exec(`INSERT INTO projects(id,name,color) VALUES('p','Project','#000');
    INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task');
    INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','t','claude-chat',0)`)
  const dropped = () =>
    h.db
      .prepare('SELECT value FROM settings WHERE key=?')
      .get(LEGACY_CHAT_TABLES_DROPPED_SETTING) as { value: string } | undefined
  return { h, dropped }
}

test('nothing left to migrate: every legacy table is dropped, once, and recorded', async () => {
  const { h, dropped } = await fixture()
  expect(await legacyChatTables(h.slayDb)).toBe(true)
  await expect(settleLegacyChatTables(h.slayDb, { now: 42 })).resolves.toEqual({ state: 'dropped' })
  expect([...legacyChatTablesSync(h.db)]).toEqual([])
  expect(await legacyChatTables(h.slayDb)).toBe(false)
  expect(dropped()).toEqual({ value: '42' })
  // Their fence/pin triggers went with them; nothing else names a dropped table.
  const left = h.db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('trigger','view','index')")
    .all() as Array<{ name: string; sql: string | null }>
  for (const table of LEGACY_CHAT_TABLES)
    expect(left.filter((r) => new RegExp(`\\b${table}\\b`).test(r.sql ?? ''))).toEqual([])
  // Idempotent: a second boot finds nothing to do and keeps the first record.
  await expect(settleLegacyChatTables(h.slayDb, { now: 99 })).resolves.toEqual({ state: 'absent' })
  expect(dropped()).toEqual({ value: '42' })
  // The task still deletes cleanly (purge triggers never name a dropped table).
  h.db.exec("DELETE FROM tasks WHERE id='t'")
})

test('legacy content still on the hub: the tables stay', async () => {
  const { h, dropped } = await fixture()
  h.db.exec(`INSERT INTO chat_events(tab_id,seq,event) VALUES('tab',0,'{"kind":"user-message"}')`)
  await expect(settleLegacyChatTables(h.slayDb, { now: 1 })).resolves.toEqual({
    state: 'retained',
    reason: 'legacy chat content in chat_events'
  })
  expect(legacyChatTablesSync(h.db).size).toBe(LEGACY_CHAT_TABLES.length)
  expect(await legacyChatTables(h.slayDb)).toBe(true)
  expect(dropped()).toBeUndefined()
})

test('a chat still migrating (or not yet migrated): the tables stay', async () => {
  for (const [state, cleanup] of [
    ['legacy', 0],
    ['copying', 0],
    ['verified', 0],
    ['active', 1]
  ] as const) {
    const { h } = await fixture()
    h.db
      .prepare(
        `INSERT INTO chat_ownership(id,task_id,tab_id,mode,computer_id,epoch,state,cleanup_pending)
        VALUES('o','t','tab','claude-chat',CASE WHEN ?='legacy' THEN NULL ELSE 'pc' END,1,?,?)`
      )
      .run(state, state, cleanup)
    await expect(settleLegacyChatTables(h.slayDb, { now: 1 })).resolves.toEqual({
      state: 'retained',
      reason: '1 chat still migrating from the hub'
    })
  }
})

test('a restored older backup brings the tables back: the next boot decides again', async () => {
  const { h, dropped } = await fixture()
  const schema = h.db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND (tbl_name IN (${LEGACY_CHAT_TABLES.map(
        (t) => `'${t}'`
      ).join(',')}))
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`
    )
    .all() as Array<{ sql: string }>
  await settleLegacyChatTables(h.slayDb, { now: 1 })
  // The restore: tables and settings as they were before the drop.
  for (const { sql } of schema) h.db.exec(sql)
  h.db.prepare('DELETE FROM settings WHERE key=?').run(LEGACY_CHAT_TABLES_DROPPED_SETTING)
  h.db.exec(`INSERT INTO chat_tab_state(tab_id,draft_text,updated_at) VALUES('tab','old draft',1)`)
  await expect(settleLegacyChatTables(h.slayDb, { now: 2 })).resolves.toMatchObject({
    state: 'retained'
  })
  expect(await legacyChatTables(h.slayDb)).toBe(true)
  // Migrated (the hub's source rows are removed): the next boot drops them again.
  h.db.exec("DELETE FROM chat_tab_state WHERE tab_id='tab'")
  await expect(settleLegacyChatTables(h.slayDb, { now: 3 })).resolves.toEqual({ state: 'dropped' })
  expect(dropped()).toEqual({ value: '3' })
  expect(await legacyChatTables(h.slayDb)).toBe(false)
})

test('an unknown object that still names a legacy table blocks the drop (never breaks it)', async () => {
  const { h } = await fixture()
  h.db.exec(`CREATE TRIGGER someone_elses AFTER INSERT ON tasks BEGIN
    DELETE FROM chat_queue WHERE tab_id=NEW.id; END;`)
  await expect(settleLegacyChatTables(h.slayDb, { now: 1 })).rejects.toThrow(
    /someone_elses.*chat_queue/
  )
  expect(legacyChatTablesSync(h.db).size).toBe(LEGACY_CHAT_TABLES.length)
  expect(await legacyChatTables(h.slayDb)).toBe(true)
})

test('rule: tables dropped on this install that are back with nothing to migrate are reported', async () => {
  const { h } = await fixture()
  const rules = async () =>
    (await checkHubChatConsistency(h.slayDb))
      .filter((v) => v.rule.startsWith('legacy-chat-tables'))
      .map((v) => v.ids.length)
  // Before the first drop: present tables are the normal state, never drift.
  expect(await rules()).toEqual([])
  await settleLegacyChatTables(h.slayDb, { now: 1 })
  expect(await rules()).toEqual([])
  // Recreated behind the hub's back (no restore: the drop record stays).
  h.db.exec('CREATE TABLE chat_queue (id TEXT PRIMARY KEY, tab_id TEXT)')
  expect(await rules()).toEqual([1])
  // A chat still migrating explains them: not drift.
  h.db.exec(`INSERT INTO chat_ownership(id,task_id,tab_id,mode,computer_id,epoch,state)
    VALUES('o','t','tab','claude-chat',NULL,1,'legacy')`)
  expect(await rules()).toEqual([])
})
