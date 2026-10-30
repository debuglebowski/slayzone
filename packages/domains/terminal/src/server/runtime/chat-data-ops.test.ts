/**
 * Unit tests for the ChatDataOps local-DB implementation (createDbChatDataOps).
 *
 * Covers the three behaviors the hub/computer split must not regress:
 *   - provider_config merge writes are idempotent (no-op writes are skipped)
 *     and field-preserving (writing one key keeps the others)
 *   - bumpLastInteraction is monotonic (older/equal timestamps are no-ops and
 *     report `false` so the caller skips the tasks:changed broadcast)
 *   - corrupt provider_config / chat_events JSON is tolerated, never thrown
 */
import { expect, test } from 'vitest'
import Database from 'better-sqlite3'
import type { SlayzoneDb } from '@slayzone/platform'
import { createDbChatDataOps } from './chat-data-ops'
import { createFakeTaskSessionStore } from './fake-task-session-store'

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
      saved_at INTEGER,
      PRIMARY KEY (tab_id, seq)
    );
    CREATE TABLE chat_timeline_checkpoints (
      tab_id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      seq INTEGER NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE chat_timeline_pages (
      tab_id TEXT NOT NULL,
      page INTEGER NOT NULL,
      start_row INTEGER NOT NULL,
      end_row INTEGER NOT NULL,
      rows TEXT NOT NULL,
      summary TEXT NOT NULL,
      search_text TEXT NOT NULL,
      PRIMARY KEY (tab_id, page)
    );
    CREATE TABLE chat_cli_snapshots (
      project_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      slash_commands TEXT NOT NULL,
      terminal_slash_commands TEXT NOT NULL,
      skills TEXT NOT NULL,
      cli_version TEXT,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, mode)
    );
    CREATE TABLE chat_cli_command_details (
      project_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      details TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, mode)
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
    },
    // One transaction, as the worker runs it.
    batchTxn: async (ops: Array<{ type: 'get' | 'all' | 'run'; sql: string; params: unknown[] }>) =>
      raw.transaction(() =>
        ops.map((op) => {
          if (op.type === 'run') runLog.push(op.sql)
          return raw.prepare(op.sql)[op.type](...(op.params as []))
        })
      )()
  } as unknown as SlayzoneDb
  return { raw, db, runLog }
}

const updateCount = (runLog: string[]): number =>
  runLog.filter((sql) => sql.startsWith('UPDATE tasks SET provider_config')).length

test('writeChatMode skips the UPDATE when the value is unchanged', async () => {
  const { raw, db, runLog } = makeDb()
  raw.prepare('INSERT INTO tasks (id) VALUES (?)').run('t1')
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())

  await ops.writeChatMode('t1', 'claude-chat', 'plan')
  expect(updateCount(runLog)).toBe(1)

  // Same value again — value-idempotent AND write-skipped.
  await ops.writeChatMode('t1', 'claude-chat', 'plan')
  expect(updateCount(runLog)).toBe(1)

  await ops.writeChatMode('t1', 'claude-chat', 'bypass')
  expect(updateCount(runLog)).toBe(2)
})

test('writes merge per-mode: one key does not clobber the others', async () => {
  const { raw, db } = makeDb()
  raw
    .prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)')
    .run('t2', JSON.stringify({ 'claude-chat': { chatMode: 'plan', chatConversationId: 'sid' } }))
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())

  await ops.writeChatModel('t2', 'claude-chat', 'sonnet')
  const cfg = await ops.readProviderConfig('t2', 'claude-chat')
  expect(cfg.chatMode).toBe('plan')
  expect(cfg.chatConversationId).toBe('sid')
  expect(cfg.chatModel).toBe('sonnet')
})

test('writeChatEffort/writeChatFastMode treat missing as null/false (no-op skip)', async () => {
  const { raw, db, runLog } = makeDb()
  raw.prepare('INSERT INTO tasks (id) VALUES (?)').run('t3')
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())

  // Missing chatEffort ≡ null, missing chatFastMode ≡ false — both no-ops.
  await ops.writeChatEffort('t3', 'claude-chat', null)
  await ops.writeChatFastMode('t3', 'codex-chat', false)
  expect(updateCount(runLog)).toBe(0)

  await ops.writeChatEffort('t3', 'claude-chat', 'high')
  await ops.writeChatFastMode('t3', 'codex-chat', true)
  expect(updateCount(runLog)).toBe(2)
})

test('clearChatConversationId no-ops when nothing stored, clears when set', async () => {
  const { raw, db, runLog } = makeDb()
  raw.prepare('INSERT INTO tasks (id) VALUES (?)').run('t4')
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())

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

test('bumpLastInteraction only moves forward and reports changed', async () => {
  const { raw, db } = makeDb()
  raw.prepare('INSERT INTO tasks (id) VALUES (?)').run('t5')
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())

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

test('readProviderConfig returns {} for corrupt provider_config', async () => {
  const { raw, db } = makeDb()
  raw.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run('t6', '{not json')
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())
  const cfg = await ops.readProviderConfig('t6', 'claude-chat')
  expect(Object.keys(cfg).length).toBe(0)
})

test('writeChatMode replaces corrupt provider_config with a fresh valid object', async () => {
  const { raw, db } = makeDb()
  raw.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run('t7', '{not json')
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())
  await ops.writeChatMode('t7', 'claude-chat', 'plan')
  const row = raw.prepare('SELECT provider_config AS v FROM tasks WHERE id = ?').get('t7') as {
    v: string
  }
  const cfg = JSON.parse(row.v) as Record<string, { chatMode?: string }>
  expect(cfg['claude-chat']?.chatMode).toBe('plan')
})

test('clearChatConversationId leaves corrupt provider_config untouched (no throw)', async () => {
  const { raw, db, runLog } = makeDb()
  raw.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run('t8', '{not json')
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())
  await ops.clearChatConversationId('t8', 'claude-chat')
  expect(updateCount(runLog)).toBe(0)
  const row = raw.prepare('SELECT provider_config AS v FROM tasks WHERE id = ?').get('t8') as {
    v: string
  }
  expect(row.v).toBe('{not json')
})

test('loadChatEvents drops corrupt event rows instead of throwing', async () => {
  const { raw, db } = makeDb()
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())
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

const cliList = (slashCommands: string[]) => ({
  slashCommands,
  terminalSlashCommands: ['doctor'],
  skills: ['simplify'],
  cliVersion: '2.1.312'
})

test('CLI command snapshot: saved per project + mode, read back through any task of the project', async () => {
  const { raw, db } = makeDb()
  raw
    .prepare('INSERT INTO tasks (id, project_id) VALUES (?, ?), (?, ?), (?, ?)')
    .run('t1', 'p1', 't2', 'p1', 't3', 'p2')
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())

  expect(await ops.getCliSnapshot('t1', 'claude-chat')).toBeNull()
  await ops.saveCliSnapshot('t1', 'claude-chat', cliList(['compact', 'context']))
  expect(await ops.getCliSnapshot('t2', 'claude-chat')).toEqual(cliList(['compact', 'context']))
  // Other project, other mode: nothing.
  expect(await ops.getCliSnapshot('t3', 'claude-chat')).toBeNull()
  expect(await ops.getCliSnapshot('t1', 'codex-chat')).toBeNull()

  // A newer list replaces the old one.
  await ops.saveCliSnapshot('t2', 'claude-chat', cliList(['compact']))
  expect(await ops.getCliSnapshot('t1', 'claude-chat')).toEqual(cliList(['compact']))
  expect(raw.prepare('SELECT count(*) AS n FROM chat_cli_snapshots').get()).toEqual({ n: 1 })
})

test('CLI command snapshot: unknown task saves nothing; corrupt rows read as null', async () => {
  const { raw, db } = makeDb()
  raw.prepare('INSERT INTO tasks (id, project_id) VALUES (?, ?)').run('t1', 'p1')
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())

  await ops.saveCliSnapshot('missing', 'claude-chat', cliList(['compact']))
  expect(raw.prepare('SELECT count(*) AS n FROM chat_cli_snapshots').get()).toEqual({ n: 0 })

  raw
    .prepare(
      `INSERT INTO chat_cli_snapshots VALUES ('p1', 'claude-chat', '{not json', '[]', '[]', NULL, 1)`
    )
    .run()
  expect(await ops.getCliSnapshot('t1', 'claude-chat')).toBeNull()
})

test('chat history is never trimmed: every saved event of a tab stays (no per-tab cap)', async () => {
  const { db } = makeDb()
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())
  for (let seq = 0; seq < 2_100; seq++) {
    await ops.persistChatEvent('tab-1', seq, { kind: 'stderr', text: `e${seq}` } as never)
  }
  const events = await ops.loadChatEvents('tab-1')
  expect(events.length).toBe(2_100)
  expect(events[0]).toMatchObject({ seq: 0, event: { kind: 'stderr', text: 'e0' } })
})

test('loadChatEventsRange reads the rows strictly between two seqs, in order', async () => {
  const { db } = makeDb()
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())
  for (let seq = 0; seq < 10; seq++) {
    await ops.persistChatEvent('tab-1', seq, { kind: 'stderr', text: `e${seq}` } as never)
    await ops.persistChatEvent('tab-2', seq, { kind: 'stderr', text: `x${seq}` } as never)
  }
  const got = await ops.loadChatEventsRange('tab-1', 2, 6)
  expect(got.map((e) => e.seq)).toEqual([3, 4, 5])
  expect(got[0].event).toEqual({ kind: 'stderr', text: 'e3' })
})

test('persistChatEvent inserts only: a second write at the same seq is a clash, not an overwrite', async () => {
  const { raw, db } = makeDb()
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())
  const first = { kind: 'stderr', text: 'first' } as never
  const second = { kind: 'stderr', text: 'second' } as never
  expect(await ops.persistChatEvent('tab-1', 0, first)).toBe('inserted')
  expect(await ops.persistChatEvent('tab-1', 0, second)).toBe('clash')
  const row = raw
    .prepare('SELECT event FROM chat_events WHERE tab_id = ? AND seq = 0')
    .get('tab-1') as {
    event: string
  }
  expect(JSON.parse(row.event)).toEqual({ kind: 'stderr', text: 'first' })
})

test('concurrent provider_config writes of different keys all land (no read-modify-write loss)', async () => {
  const { raw, db } = makeDb()
  raw
    .prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)')
    .run('t9', JSON.stringify({ 'claude-chat': { chatConversationId: 'sid' }, other: { k: 1 } }))
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())
  await Promise.all([
    ops.writeChatMode('t9', 'claude-chat', 'plan'),
    ops.writeChatModel('t9', 'claude-chat', 'sonnet'),
    ops.writeChatEffort('t9', 'claude-chat', 'high'),
    ops.writeChatFastMode('t9', 'claude-chat', true),
    ops.clearChatConversationId('t9', 'claude-chat')
  ])
  const row = raw.prepare('SELECT provider_config AS v FROM tasks WHERE id = ?').get('t9') as {
    v: string
  }
  expect(JSON.parse(row.v)).toEqual({
    'claude-chat': {
      chatConversationId: null,
      chatMode: 'plan',
      chatModel: 'sonnet',
      chatEffort: 'high',
      chatFastMode: true
    },
    other: { k: 1 }
  })
})

test('a mode entry that is not an object is replaced by one holding the new key', async () => {
  const { raw, db } = makeDb()
  raw
    .prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)')
    .run('t10', JSON.stringify({ 'claude-chat': null }))
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())
  await ops.writeChatModel('t10', 'claude-chat', 'opus')
  expect((await ops.readProviderConfig('t10', 'claude-chat')).chatModel).toBe('opus')
})

test('CLI command details: stored per project + mode, read on their own (no command list needed)', async () => {
  const { raw, db } = makeDb()
  raw
    .prepare('INSERT INTO tasks (id, project_id) VALUES (?, ?), (?, ?)')
    .run('t1', 'p1', 't2', 'p1')
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())
  const details = { compact: { description: 'Free up context', argumentHint: '<instructions>' } }

  expect(await ops.getCliCommandDetails('t1', 'claude-chat')).toBeNull()
  // The CLI answered `initialize` before any turn: no list, details known.
  await ops.saveCliCommandDetails('t1', 'claude-chat', details)
  expect(await ops.getCliCommandDetails('t2', 'claude-chat')).toEqual(details)
  expect(await ops.getCliSnapshot('t2', 'claude-chat')).toBeNull()
  const next = { context: { description: 'Show context', argumentHint: '' } }
  await ops.saveCliCommandDetails('t2', 'claude-chat', next)
  expect(await ops.getCliCommandDetails('t1', 'claude-chat')).toEqual(next)
  expect(await ops.getCliCommandDetails('t1', 'codex-chat')).toBeNull()
  expect(raw.prepare('SELECT count(*) AS n FROM chat_cli_command_details').get()).toEqual({ n: 1 })
})

test('CLI command details: corrupt JSON reads as no details', async () => {
  const { raw, db } = makeDb()
  raw.prepare('INSERT INTO tasks (id, project_id) VALUES (?, ?)').run('t1', 'p1')
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())
  raw
    .prepare(
      `INSERT INTO chat_cli_command_details (project_id, mode, details, observed_at) VALUES ('p1', 'claude-chat', '{nope', 1)`
    )
    .run()
  expect(await ops.getCliCommandDetails('t1', 'claude-chat')).toBeNull()
})

test('a saved event keeps the time it was saved (ms); rows saved before fall back to created_at', async () => {
  const { raw, db } = makeDb()
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())
  raw
    .prepare('INSERT INTO chat_events (tab_id, seq, event, created_at) VALUES (?, ?, ?, ?)')
    .run('tab-1', 0, JSON.stringify({ kind: 'stderr', text: 'old' }), '2026-10-30 12:00:05')
  await ops.persistChatEvent('tab-1', 1, { kind: 'stderr', text: 'new' } as never, 1793376000123)
  const all = await ops.loadChatEvents('tab-1')
  expect(all.map((e) => e.at)).toEqual([Date.UTC(2026, 9, 30, 12, 0, 5), 1793376000123])
  const range = await ops.loadChatEventsRange('tab-1', -1, 9)
  expect(range.map((e) => e.at)).toEqual([Date.UTC(2026, 9, 30, 12, 0, 5), 1793376000123])
})

test('timeline projection: pages + checkpoint saved together, read back, searched, dropped, cleared with the events', async () => {
  const { db } = makeDb()
  const ops = createDbChatDataOps(db, createFakeTaskSessionStore())
  const page = (n: number, text: string) => ({
    page: n,
    startRow: n * 2,
    endRow: n * 2 + 2,
    rows: `[${n}]`,
    summary: `{"p":${n}}`,
    searchText: text
  })
  expect(await ops.loadTimelineCheckpoint('tab-1')).toBeNull()
  await ops.saveTimeline('tab-1', {
    dropPagesFrom: null,
    pages: [page(0, 'alpha\u0000beta'), page(1, 'gamma'), page(2, 'beta again')],
    checkpoint: { version: '1', seq: 41, data: '{}' }
  })
  expect(await ops.loadTimelineCheckpoint('tab-1')).toEqual({ version: '1', seq: 41, data: '{}' })
  expect((await ops.loadTimelinePages('tab-1', [2, 0])).sort((a, b) => a.page - b.page)).toEqual([
    { page: 0, rows: '[0]' },
    { page: 2, rows: '[2]' }
  ])
  expect(await ops.loadTimelineSummaries('tab-1')).toEqual([
    { page: 0, summary: '{"p":0}' },
    { page: 1, summary: '{"p":1}' },
    { page: 2, summary: '{"p":2}' }
  ])
  expect(await ops.searchTimelinePages('tab-1', 'beta')).toEqual([0, 2])
  // Rows moved: pages from 1 on go, the new page 1 and checkpoint land with them.
  await ops.saveTimeline('tab-1', {
    dropPagesFrom: 1,
    pages: [page(1, 'delta')],
    checkpoint: { version: '1', seq: 50, data: '{"x":1}' }
  })
  expect((await ops.loadTimelineSummaries('tab-1')).map((p) => p.page)).toEqual([0, 1])
  expect(await ops.searchTimelinePages('tab-1', 'beta')).toEqual([0])
  expect((await ops.loadTimelineCheckpoint('tab-1'))?.seq).toBe(50)
  // Pages written ahead of any checkpoint (a long run): the stored one goes.
  await ops.saveTimeline('tab-1', {
    dropPagesFrom: null,
    pages: [page(2, 'eps')],
    checkpoint: null
  })
  expect(await ops.loadTimelineCheckpoint('tab-1')).toBeNull()
  expect((await ops.loadTimelineSummaries('tab-1')).map((p) => p.page)).toEqual([0, 1, 2])
  // Thrown away (`clearTimeline`): pages and checkpoint.
  await ops.saveTimeline('tab-1', {
    dropPagesFrom: null,
    pages: [],
    checkpoint: { version: '1', seq: 60, data: '{}' }
  })
  await ops.clearTimeline('tab-1')
  expect(await ops.loadTimelineCheckpoint('tab-1')).toBeNull()
  expect(await ops.loadTimelineSummaries('tab-1')).toEqual([])
  await ops.saveTimeline('tab-1', {
    dropPagesFrom: null,
    pages: [page(0, 'x')],
    checkpoint: { version: '1', seq: 61, data: '{}' }
  })
  await ops.clearChatEventsForTab('tab-1')
  expect(await ops.loadTimelineCheckpoint('tab-1')).toBeNull()
  expect(await ops.loadTimelineSummaries('tab-1')).toEqual([])
})
