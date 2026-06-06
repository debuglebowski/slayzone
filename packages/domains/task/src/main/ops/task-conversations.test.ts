import Database from 'better-sqlite3'
import type { BatchOp, SlayzoneDb } from '@slayzone/platform'
import { ALL_ORIGINS } from '@slayzone/task/shared'
import {
  recordConversation,
  getCurrentConversationId,
  listConversationHistory,
  recordPendingSpawn,
  findPendingSpawn,
  prunePendingSpawns
} from './task-conversations.js'

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

// Minimal harness — `tasks` (for legacy dual-write) + `task_conversations`.
const raw = new Database(':memory:')
raw.exec(`
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    provider_config TEXT,
    claude_conversation_id TEXT,
    codex_conversation_id TEXT,
    cursor_conversation_id TEXT,
    gemini_conversation_id TEXT,
    opencode_conversation_id TEXT
  );
  CREATE TABLE task_conversations (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL,
    mode            TEXT NOT NULL,
    conversation_id TEXT,
    origin          TEXT NOT NULL,
    pending_meta    TEXT,
    created_at      INTEGER NOT NULL,
    CHECK (origin IN (
      'slay-spawned-fresh',
      'slay-spawned-resume',
      'cas-repoint-heal',
      'legacy-migration',
      'foreign-observed',
      'manual-reset',
      'pending-spawn'
    ))
  );
`)
raw
  .prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)')
  .run('t1', '{}')

const db: SlayzoneDb = {
  async get<T = unknown>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return raw.prepare(sql).get(...params) as T | undefined
  },
  async all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    return raw.prepare(sql).all(...params) as T[]
  },
  async run(sql: string, params: unknown[] = []) {
    const r = raw.prepare(sql).run(...params)
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
  },
  async batchTxn(ops: BatchOp[]): Promise<unknown[]> {
    return raw.transaction(() =>
      ops.map((op) => raw.prepare(op.sql)[op.type](...op.params))
    )()
  }
} as unknown as SlayzoneDb

async function main(): Promise<void> {
  // 1. Honored read returns latest honored row.
  await recordConversation(db, {
    taskId: 't1',
    mode: 'claude-code',
    conversationId: 'C1',
    origin: 'slay-spawned-fresh'
  })
  await sleep(2)
  await recordConversation(db, {
    taskId: 't1',
    mode: 'claude-code',
    conversationId: 'C2',
    origin: 'slay-spawned-resume'
  })
  assert(
    (await getCurrentConversationId(db, 't1', 'claude-code')) === 'C2',
    'latest honored row should be current'
  )

  // 2. Foreign-observed rows are NEVER current — even when latest.
  await sleep(2)
  await recordConversation(db, {
    taskId: 't1',
    mode: 'claude-code',
    conversationId: 'F1',
    origin: 'foreign-observed'
  })
  assert(
    (await getCurrentConversationId(db, 't1', 'claude-code')) === 'C2',
    'foreign-observed must not become current — last honored (C2) should win'
  )

  // 3. Pending-spawn rows are NEVER current.
  await sleep(2)
  await recordPendingSpawn(db, {
    taskId: 't1',
    mode: 'claude-code',
    expectedSessionId: 'P1',
    usedResume: false
  })
  assert(
    (await getCurrentConversationId(db, 't1', 'claude-code')) === 'C2',
    'pending-spawn must not become current'
  )

  // 4. Manual-reset is a CUTOFF — later honored rows become current again,
  //    but earlier honored rows (C1/C2) are hidden.
  await sleep(2)
  await recordConversation(db, {
    taskId: 't1',
    mode: 'claude-code',
    conversationId: null,
    origin: 'manual-reset'
  })
  assert(
    (await getCurrentConversationId(db, 't1', 'claude-code')) === null,
    'after manual-reset with no later honored row, current must be NULL'
  )

  await sleep(2)
  await recordConversation(db, {
    taskId: 't1',
    mode: 'claude-code',
    conversationId: 'C3',
    origin: 'slay-spawned-fresh'
  })
  assert(
    (await getCurrentConversationId(db, 't1', 'claude-code')) === 'C3',
    'a fresh row strictly after manual-reset becomes current'
  )

  // 5. listConversationHistory returns every row including foreign + pending.
  const history = await listConversationHistory(db, 't1', 'claude-code')
  assert(
    history.length === 6,
    `audit history should have all 6 rows, got ${history.length}`
  )
  const origins = history.map((h) => h.origin).sort()
  assert(
    origins.includes('foreign-observed') && origins.includes('pending-spawn'),
    'audit history must include foreign + pending rows'
  )

  // 6. findPendingSpawn round-trip — null expected ("fresh" sentinel).
  await recordPendingSpawn(db, {
    taskId: 't1',
    mode: 'codex',
    expectedSessionId: null,
    usedResume: false
  })
  const p1 = await findPendingSpawn(db, 't1', 'codex')
  assert(p1 !== null, 'fresh pending row should be found')
  assert(p1?.expectedSessionId === null, 'expectedSessionId should be null')
  assert(p1?.usedResume === false, 'usedResume preserved')

  // 7. findPendingSpawn with explicit id.
  await recordPendingSpawn(db, {
    taskId: 't1',
    mode: 'gemini',
    expectedSessionId: 'EXPECTED',
    usedResume: true
  })
  const p2 = await findPendingSpawn(db, 't1', 'gemini')
  assert(p2?.expectedSessionId === 'EXPECTED', 'expected id round-tripped')
  assert(p2?.usedResume === true, 'usedResume true preserved')

  // 8. prunePendingSpawns by scope removes pending rows for that (task, mode).
  const pruned = await prunePendingSpawns(db, { taskId: 't1', mode: 'codex' })
  assert(pruned === 1, `expected 1 pruned row, got ${pruned}`)
  assert(
    (await findPendingSpawn(db, 't1', 'codex')) === null,
    'codex pending should be gone after prune'
  )
  assert(
    (await findPendingSpawn(db, 't1', 'gemini')) !== null,
    'gemini pending should still be present'
  )

  // 9. ENUM/CHECK sync — every value in ALL_ORIGINS INSERTs cleanly. This
  //    catches drift between the TS enum and the SQL CHECK constraint.
  for (const origin of ALL_ORIGINS) {
    await recordConversation(db, {
      taskId: 't1',
      mode: '__enum_sync__',
      conversationId: origin === 'manual-reset' ? null : `id-${origin}`,
      origin,
      pendingMeta:
        origin === 'pending-spawn'
          ? { usedResume: false, spawnedAt: Date.now() }
          : undefined
    })
  }

  // 10. Legacy dual-write — honored rows write to provider_config + legacy col.
  await recordConversation(db, {
    taskId: 't1',
    mode: 'claude-code',
    conversationId: 'LEG1',
    origin: 'slay-spawned-fresh'
  })
  const taskRow = raw
    .prepare(
      'SELECT provider_config, claude_conversation_id FROM tasks WHERE id = ?'
    )
    .get('t1') as { provider_config: string; claude_conversation_id: string }
  assert(
    taskRow.claude_conversation_id === 'LEG1',
    'legacy column must be dual-written for honored origins'
  )
  assert(
    taskRow.provider_config.includes('LEG1'),
    'provider_config JSON must be dual-written'
  )

  // 10b. Phase 1: a `manual-reset` for the same (task, mode) clears the legacy
  //      JSON field AND the legacy column so live consumers immediately stop
  //      seeing the broken binding. Foreign-observed (tested below) must NOT
  //      clear; the two have opposite semantics.
  await recordConversation(db, {
    taskId: 't1',
    mode: 'claude-code',
    conversationId: null,
    origin: 'manual-reset'
  })
  const afterReset = raw
    .prepare(
      'SELECT provider_config, claude_conversation_id FROM tasks WHERE id = ?'
    )
    .get('t1') as { provider_config: string; claude_conversation_id: string | null }
  assert(
    afterReset.claude_conversation_id === null,
    'manual-reset must clear the legacy *_conversation_id column'
  )
  const parsed = JSON.parse(afterReset.provider_config) as Record<
    string,
    { conversationId?: string | null; chatConversationId?: string | null }
  >
  assert(
    (parsed['claude-code']?.conversationId ?? null) === null,
    'manual-reset must clear provider_config.{mode}.conversationId'
  )
  assert(
    (parsed['claude-code']?.chatConversationId ?? null) === null,
    'manual-reset must clear provider_config.{mode}.chatConversationId'
  )

  // 11. Foreign / pending writes do NOT touch the legacy field.
  const beforeLegacy = (raw
    .prepare('SELECT claude_conversation_id AS x FROM tasks WHERE id = ?')
    .get('t1') as { x: string }).x
  await recordConversation(db, {
    taskId: 't1',
    mode: 'claude-code',
    conversationId: 'FORE1',
    origin: 'foreign-observed'
  })
  const afterLegacy = (raw
    .prepare('SELECT claude_conversation_id AS x FROM tasks WHERE id = ?')
    .get('t1') as { x: string }).x
  assert(
    beforeLegacy === afterLegacy,
    'foreign-observed must NOT mutate the legacy field'
  )

  console.log('OK — task_conversations all checks passed')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
