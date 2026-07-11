/**
 * Unit tests for the ChatDataOps local-DB implementation (createDbChatDataOps).
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --experimental-loader ./packages/shared/test-utils/loader.ts \
 *   packages/domains/terminal/src/server/runtime/chat-data-ops.test.ts
 *
 * Covers the three behaviors the hub/runner split must not regress:
 *   - provider_config merge writes are idempotent (no-op writes are skipped)
 *     and field-preserving (writing one key keeps the others)
 *   - bumpLastInteraction is monotonic (older/equal timestamps are no-ops and
 *     report `false` so the caller skips the tasks:changed broadcast)
 *   - corrupt provider_config / chat_events JSON is tolerated, never thrown
 */
import Database from 'better-sqlite3'
import type { SlayzoneDb } from '@slayzone/platform'
import { createDbChatDataOps } from './chat-data-ops'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${e}`)
    failed++
  }
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T): void {
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toBeTruthy(): void {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`)
    },
    toBeFalsy(): void {
      if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`)
    }
  }
}

/**
 * Minimal async SlayzoneDb bridge over a raw better-sqlite3 handle, mirroring
 * the worker-thread proxy shape the impl runs against in production. `runLog`
 * records every executed run() SQL so tests can assert no-op writes are
 * actually skipped (not just value-idempotent).
 */
function makeDb(): { raw: Database.Database; db: SlayzoneDb; runLog: string[] } {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      provider_config TEXT,
      last_interaction_at INTEGER
    );
    CREATE TABLE terminal_modes (
      id TEXT PRIMARY KEY,
      default_flags TEXT
    );
    CREATE TABLE chat_events (
      tab_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (tab_id, seq)
    );
  `)
  const runLog: string[] = []
  const db = {
    prepare(sql: string) {
      const stmt = raw.prepare(sql)
      return {
        get: async (...params: unknown[]) => stmt.get(...(params as [])),
        all: async (...params: unknown[]) => stmt.all(...(params as [])),
        run: async (...params: unknown[]) => {
          runLog.push(sql)
          return stmt.run(...(params as []))
        }
      }
    }
  } as unknown as SlayzoneDb
  return { raw, db, runLog }
}

const updateCount = (runLog: string[]): number =>
  runLog.filter((sql) => sql.startsWith('UPDATE tasks SET provider_config')).length

console.log('\nchat-data-ops tests\n')

console.log('provider_config merge idempotency\n')

await test('writeChatMode skips the UPDATE when the value is unchanged', async () => {
  const { raw, db, runLog } = makeDb()
  raw.prepare('INSERT INTO tasks (id) VALUES (?)').run('t1')
  const ops = createDbChatDataOps(db)

  await ops.writeChatMode('t1', 'claude-chat', 'plan')
  expect(updateCount(runLog)).toBe(1)

  // Same value again — value-idempotent AND write-skipped.
  await ops.writeChatMode('t1', 'claude-chat', 'plan')
  expect(updateCount(runLog)).toBe(1)

  await ops.writeChatMode('t1', 'claude-chat', 'bypass')
  expect(updateCount(runLog)).toBe(2)
})

await test('writes merge per-mode: one key does not clobber the others', async () => {
  const { raw, db } = makeDb()
  raw
    .prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)')
    .run('t2', JSON.stringify({ 'claude-chat': { chatMode: 'plan', chatConversationId: 'sid' } }))
  const ops = createDbChatDataOps(db)

  await ops.writeChatModel('t2', 'claude-chat', 'sonnet')
  const cfg = await ops.readProviderConfig('t2', 'claude-chat')
  expect(cfg.chatMode).toBe('plan')
  expect(cfg.chatConversationId).toBe('sid')
  expect(cfg.chatModel).toBe('sonnet')
})

await test('writeChatEffort/writeChatFastMode treat missing as null/false (no-op skip)', async () => {
  const { raw, db, runLog } = makeDb()
  raw.prepare('INSERT INTO tasks (id) VALUES (?)').run('t3')
  const ops = createDbChatDataOps(db)

  // Missing chatEffort ≡ null, missing chatFastMode ≡ false — both no-ops.
  await ops.writeChatEffort('t3', 'claude-chat', null)
  await ops.writeChatFastMode('t3', 'codex-chat', false)
  expect(updateCount(runLog)).toBe(0)

  await ops.writeChatEffort('t3', 'claude-chat', 'high')
  await ops.writeChatFastMode('t3', 'codex-chat', true)
  expect(updateCount(runLog)).toBe(2)
})

await test('clearChatConversationId no-ops when nothing stored, clears when set', async () => {
  const { raw, db, runLog } = makeDb()
  raw.prepare('INSERT INTO tasks (id) VALUES (?)').run('t4')
  const ops = createDbChatDataOps(db)

  // NULL provider_config → early return, no write.
  await ops.clearChatConversationId('t4', 'claude-chat')
  expect(updateCount(runLog)).toBe(0)

  raw
    .prepare('UPDATE tasks SET provider_config = ? WHERE id = ?')
    .run(JSON.stringify({ 'claude-chat': { chatConversationId: 'sid', chatMode: 'plan' } }), 't4')
  await ops.clearChatConversationId('t4', 'claude-chat')
  const cfg = await ops.readProviderConfig('t4', 'claude-chat')
  expect(cfg.chatConversationId).toBe(null)
  expect(cfg.chatMode).toBe('plan')

  // Already-null id → early return, no second write.
  const writes = updateCount(runLog)
  await ops.clearChatConversationId('t4', 'claude-chat')
  expect(updateCount(runLog)).toBe(writes)
})

console.log('\nbumpLastInteraction monotonic guard\n')

await test('bumpLastInteraction only moves forward and reports changed', async () => {
  const { raw, db } = makeDb()
  raw.prepare('INSERT INTO tasks (id) VALUES (?)').run('t5')
  const ops = createDbChatDataOps(db)

  // NULL → set.
  expect(await ops.bumpLastInteraction('t5', 1000)).toBe(true)
  let row = raw.prepare('SELECT last_interaction_at AS v FROM tasks WHERE id = ?').get('t5') as {
    v: number
  }
  expect(row.v).toBe(1000)

  // Older timestamp → no-op, reports false (caller skips tasks:changed).
  expect(await ops.bumpLastInteraction('t5', 500)).toBe(false)
  row = raw.prepare('SELECT last_interaction_at AS v FROM tasks WHERE id = ?').get('t5') as {
    v: number
  }
  expect(row.v).toBe(1000)

  // Equal timestamp → strict `<` guard, still a no-op.
  expect(await ops.bumpLastInteraction('t5', 1000)).toBe(false)

  // Newer → moves.
  expect(await ops.bumpLastInteraction('t5', 2000)).toBe(true)
  row = raw.prepare('SELECT last_interaction_at AS v FROM tasks WHERE id = ?').get('t5') as {
    v: number
  }
  expect(row.v).toBe(2000)

  // Unknown task → no row changed.
  expect(await ops.bumpLastInteraction('missing', 3000)).toBe(false)
})

console.log('\ncorrupt-JSON tolerance\n')

await test('readProviderConfig returns {} for corrupt provider_config', async () => {
  const { raw, db } = makeDb()
  raw.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run('t6', '{not json')
  const ops = createDbChatDataOps(db)
  const cfg = await ops.readProviderConfig('t6', 'claude-chat')
  expect(Object.keys(cfg).length).toBe(0)
})

await test('writeChatMode replaces corrupt provider_config with a fresh valid object', async () => {
  const { raw, db } = makeDb()
  raw.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run('t7', '{not json')
  const ops = createDbChatDataOps(db)
  await ops.writeChatMode('t7', 'claude-chat', 'plan')
  const row = raw.prepare('SELECT provider_config AS v FROM tasks WHERE id = ?').get('t7') as {
    v: string
  }
  const cfg = JSON.parse(row.v) as Record<string, { chatMode?: string }>
  expect(cfg['claude-chat']?.chatMode).toBe('plan')
})

await test('clearChatConversationId leaves corrupt provider_config untouched (no throw)', async () => {
  const { raw, db, runLog } = makeDb()
  raw.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run('t8', '{not json')
  const ops = createDbChatDataOps(db)
  await ops.clearChatConversationId('t8', 'claude-chat')
  expect(updateCount(runLog)).toBe(0)
  const row = raw.prepare('SELECT provider_config AS v FROM tasks WHERE id = ?').get('t8') as {
    v: string
  }
  expect(row.v).toBe('{not json')
})

await test('loadChatEvents drops corrupt event rows instead of throwing', async () => {
  const { raw, db } = makeDb()
  const ops = createDbChatDataOps(db)
  await ops.persistChatEvent('tab-1', 0, {
    kind: 'assistant-text',
    messageId: 'm1',
    text: 'ok'
  } as never)
  raw
    .prepare('INSERT INTO chat_events (tab_id, seq, event) VALUES (?, ?, ?)')
    .run('tab-1', 1, '{corrupt')
  const events = await ops.loadChatEvents('tab-1')
  expect(events.length).toBe(1)
  expect(events[0].seq).toBe(0)
  expect(await ops.getNextSeqForTab('tab-1')).toBe(2)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
