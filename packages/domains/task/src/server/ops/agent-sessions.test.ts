import Database from 'better-sqlite3'
import type { BatchOp, SlayzoneDb } from '@slayzone/platform'
import {
  recordConversation,
  recordPendingSpawn,
  prunePendingSpawns
} from './task-conversations.js'
// Old (v145) readers — the parity baseline.
import {
  getCurrentConversationId as getCurrentOld,
  listConversationHistory as listOld
} from './task-conversations.js'
// New (v147) readers — agent_sessions + session_resets.
import {
  getCurrentConversationId as getCurrentNew,
  listConversationHistory as listNew,
  findPendingSpawn as findNew
} from './agent-sessions.js'

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

// Harness — tasks (legacy dual-write) + v145 ledger + v147 agent-session tables.
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
      'slay-spawned-fresh','slay-spawned-resume','cas-repoint-heal',
      'legacy-migration','foreign-observed','manual-reset','pending-spawn'
    ))
  );
  CREATE TABLE agent_sessions (
    id              TEXT PRIMARY KEY,
    mode            TEXT NOT NULL,
    cwd             TEXT,
    task_id         TEXT,
    conversation_id TEXT,
    origin          TEXT NOT NULL,
    status          TEXT NOT NULL,
    pending_meta    TEXT,
    created_at      INTEGER NOT NULL,
    bound_at        INTEGER,
    CHECK (origin IN (
      'slay-spawned-fresh','slay-spawned-resume','cas-repoint-heal',
      'legacy-migration','foreign-observed','pending-spawn'
    )),
    CHECK (status IN ('pooled','bound','dead'))
  );
  CREATE TABLE session_resets (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL,
    mode       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`)
raw.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run('t1', '{}')

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Assert the new resolver agrees with the old ledger AND the expected value. */
async function parity(mode: string, expected: string | null, label: string): Promise<void> {
  const old = await getCurrentOld(db, 't1', mode)
  const neu = await getCurrentNew(db, 't1', mode)
  assert(old === expected, `${label}: old resolver expected ${expected}, got ${old}`)
  assert(neu === expected, `${label}: new resolver expected ${expected}, got ${neu}`)
  assert(old === neu, `${label}: new/old resolver disagree (${old} vs ${neu})`)
}

async function main(): Promise<void> {
  // 1. Latest honored row is current — both resolvers.
  await recordConversation(db, { taskId: 't1', mode: 'claude-code', conversationId: 'C1', origin: 'slay-spawned-fresh' })
  await sleep(2)
  await recordConversation(db, { taskId: 't1', mode: 'claude-code', conversationId: 'C2', origin: 'slay-spawned-resume' })
  await parity('claude-code', 'C2', 'latest honored')

  // 2. Foreign-observed never current.
  await sleep(2)
  await recordConversation(db, { taskId: 't1', mode: 'claude-code', conversationId: 'F1', origin: 'foreign-observed' })
  await parity('claude-code', 'C2', 'foreign-observed ignored')

  // 3. Pending-spawn never current.
  await sleep(2)
  await recordPendingSpawn(db, { taskId: 't1', mode: 'claude-code', expectedSessionId: 'P1', usedResume: false })
  await parity('claude-code', 'C2', 'pending-spawn ignored')

  // 4. Reset is a CUTOFF — modeled as a session_resets event for the new path.
  await sleep(2)
  await recordConversation(db, { taskId: 't1', mode: 'claude-code', conversationId: null, origin: 'manual-reset' })
  await parity('claude-code', null, 'after reset, no later honored row → null')
  // The reset landed in session_resets, NOT agent_sessions.
  const resetRows = raw.prepare(`SELECT count(*) AS n FROM session_resets WHERE task_id='t1' AND mode='claude-code'`).get() as { n: number }
  assert(resetRows.n === 1, `reset must be a session_resets row, got ${resetRows.n}`)
  const resetInSessions = raw.prepare(`SELECT count(*) AS n FROM agent_sessions WHERE origin='manual-reset'`).get() as { n: number }
  assert(resetInSessions.n === 0, 'manual-reset must never appear in agent_sessions')

  await sleep(2)
  await recordConversation(db, { taskId: 't1', mode: 'claude-code', conversationId: 'C3', origin: 'slay-spawned-fresh' })
  await parity('claude-code', 'C3', 'fresh row strictly after reset becomes current')

  // 5. History parity (minus the reset row, which is not a session). Old ledger
  //    has 6 rows (incl. manual-reset); new has the 5 sessions.
  const oldHist = await listOld(db, 't1', 'claude-code')
  const newHist = await listNew(db, 't1', 'claude-code')
  assert(oldHist.length === 6, `old history should have 6 rows, got ${oldHist.length}`)
  assert(newHist.length === 5, `new history should have 5 session rows, got ${newHist.length}`)
  assert(
    !newHist.some((h) => h.origin === 'manual-reset'),
    'new history must not contain manual-reset'
  )
  assert(
    newHist.some((h) => h.origin === 'foreign-observed') &&
      newHist.some((h) => h.origin === 'pending-spawn'),
    'new history must include foreign + pending session rows'
  )

  // 6. findPendingSpawn (new) round-trips — null expected ("fresh" sentinel).
  await recordPendingSpawn(db, { taskId: 't1', mode: 'codex', expectedSessionId: null, usedResume: false })
  const p1 = await findNew(db, 't1', 'codex')
  assert(p1 !== null, 'fresh pending row should be found via agent_sessions')
  assert(p1?.expectedSessionId === null, 'expectedSessionId null preserved')
  assert(p1?.usedResume === false, 'usedResume preserved')

  // 7. findPendingSpawn (new) with explicit id.
  await recordPendingSpawn(db, { taskId: 't1', mode: 'gemini', expectedSessionId: 'EXPECTED', usedResume: true })
  const p2 = await findNew(db, 't1', 'gemini')
  assert(p2?.expectedSessionId === 'EXPECTED', 'expected id round-tripped')
  assert(p2?.usedResume === true, 'usedResume true preserved')

  // 8. prunePendingSpawns mirror — clears the shadow agent_sessions pending row.
  const pruned = await prunePendingSpawns(db, { taskId: 't1', mode: 'codex' })
  assert(pruned === 1, `expected 1 pruned task_conversations row, got ${pruned}`)
  assert(
    (await findNew(db, 't1', 'codex')) === null,
    'codex pending must be gone from agent_sessions after prune'
  )
  assert(
    (await findNew(db, 't1', 'gemini')) !== null,
    'gemini pending must still be present in agent_sessions'
  )

  // 9. Cross-mode reset isolation — a reset on claude-code must not affect codex.
  await recordConversation(db, { taskId: 't1', mode: 'opencode', conversationId: 'O1', origin: 'slay-spawned-fresh' })
  await parity('opencode', 'O1', 'unrelated mode unaffected by claude-code reset')

  // 10. Batched resolver parity (shared.ts attachCurrentConversationByMode) —
  //     the ROW_NUMBER window query over many (task, mode) pairs must agree
  //     with the single-row resolver for every pair. Seed a second task with
  //     its own reset + post-reset session.
  await recordConversation(db, { taskId: 't2', mode: 'claude-code', conversationId: 'D1', origin: 'slay-spawned-fresh' })
  await sleep(2)
  await recordConversation(db, { taskId: 't2', mode: 'claude-code', conversationId: null, origin: 'manual-reset' })
  await sleep(2)
  await recordConversation(db, { taskId: 't2', mode: 'claude-code', conversationId: 'D2', origin: 'slay-spawned-resume' })
  await recordConversation(db, { taskId: 't2', mode: 'codex', conversationId: 'E1', origin: 'slay-spawned-fresh' })

  const ids = ['t1', 't2']
  const ph = ids.map(() => '?').join(',')
  const batched = await db.all<{ task_id: string; mode: string; conversation_id: string | null }>(
    `WITH reset AS (
       SELECT task_id, mode, max(created_at) AS at FROM session_resets
       WHERE task_id IN (${ph}) GROUP BY task_id, mode
     ),
     ranked AS (
       SELECT s.task_id, s.mode, s.conversation_id,
         ROW_NUMBER() OVER (PARTITION BY s.task_id, s.mode ORDER BY s.created_at DESC) AS rn
       FROM agent_sessions s
       LEFT JOIN reset r ON r.task_id = s.task_id AND r.mode = s.mode
       WHERE s.task_id IN (${ph})
         AND s.conversation_id IS NOT NULL
         AND s.origin IN ('slay-spawned-fresh','slay-spawned-resume','cas-repoint-heal','legacy-migration')
         AND s.created_at > coalesce(r.at, 0)
     )
     SELECT task_id, mode, conversation_id FROM ranked WHERE rn = 1`,
    [...ids, ...ids]
  )
  const batchedMap = new Map(batched.map((r) => [`${r.task_id}:${r.mode}`, r.conversation_id]))
  for (const [taskId, mode] of [['t1', 'claude-code'], ['t1', 'opencode'], ['t2', 'claude-code'], ['t2', 'codex']] as const) {
    const single = await getCurrentNew(db, taskId, mode)
    const batchedVal = batchedMap.get(`${taskId}:${mode}`) ?? null
    assert(
      single === batchedVal,
      `batched resolver disagrees with single for ${taskId}:${mode} (single=${single}, batched=${batchedVal})`
    )
  }
  // Spot-check the expected post-reset winner for t2.
  assert(batchedMap.get('t2:claude-code') === 'D2', `t2 claude-code should resolve to D2, got ${batchedMap.get('t2:claude-code')}`)

  console.log('OK — agent_sessions parity checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
