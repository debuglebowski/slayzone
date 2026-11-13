import { expect, test } from 'vitest'
import { legacyChatTables, legacyChatTablesSync } from '@slayzone/platform/legacy-chat-tables'
import { LEGACY_CHAT_TABLES_PASS } from '@slayzone/chat-runtime/hub'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { settleLegacyChatTablesAtBoot } from './legacy-chat-tables-boot'

test('boot drops the migrated legacy chat tables and says so', async () => {
  const h = await createTestHarness()
  const lines: string[] = []
  await expect(settleLegacyChatTablesAtBoot(h.slayDb, (l) => lines.push(l))).resolves.toEqual({
    state: 'dropped'
  })
  expect(legacyChatTablesSync(h.db).size).toBe(0)
  expect(lines).toEqual(['[chat] legacy hub chat tables dropped (all chats migrated)'])
})

test('a failed drop never blocks boot: recorded under Needs attention, tables kept', async () => {
  const h = await createTestHarness()
  h.db.exec(`CREATE TRIGGER foreign_dep AFTER INSERT ON tasks BEGIN
    DELETE FROM chat_events WHERE tab_id=NEW.id; END;`)
  const errors: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '))
  try {
    await expect(settleLegacyChatTablesAtBoot(h.slayDb, () => {})).resolves.toBeNull()
  } finally {
    console.error = original
  }
  expect(await legacyChatTables(h.slayDb)).toBe(true)
  expect(h.db.prepare('SELECT origin,pass,item_key,kind FROM item_faults').all()).toEqual([
    {
      origin: 'hub',
      pass: LEGACY_CHAT_TABLES_PASS,
      item_key: 'legacy-chat-tables',
      kind: 'structural'
    }
  ])
  expect(errors.join('\n')).toContain('foreign_dep names chat_events')
  // Fixed: the next boot drops them and clears the fault.
  h.db.exec('DROP TRIGGER foreign_dep')
  await expect(settleLegacyChatTablesAtBoot(h.slayDb, () => {})).resolves.toEqual({
    state: 'dropped'
  })
  expect(h.db.prepare('SELECT COUNT(*) n FROM item_faults').get()).toEqual({ n: 0 })
})
