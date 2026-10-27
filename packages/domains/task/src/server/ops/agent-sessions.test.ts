import { describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import type { BatchOp, SlayzoneDb } from '@slayzone/platform'
import { recordConversation, recordPendingSpawn, prunePendingSpawns } from './task-conversations.js'
// Old (v145) readers — the parity baseline.
import {
  getCurrentConversationId as getCurrentOld,
  listConversationHistory as listOld
} from './task-conversations.js'
// New (v147) readers — agent_sessions + session_resets.
import {
  getCurrentConversationId as getCurrentNew,
  listConversationHistory as listNew,
  findPendingSpawn as findNew,
  recordSessionSpawn,
  confirmSessionConversation,
  bindSessionToTask,
  markSessionFirstTurn,
  resumableSessionSql,
  OWNED_AT_SQL
} from './agent-sessions.js'

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
    tab_id          TEXT,
    ended_at        INTEGER,
    CHECK (origin IN (
      'slay-spawned-fresh','slay-spawned-resume','in-band-clear','user-selected',
      'cas-repoint-heal','legacy-migration','foreign-observed','pending-spawn'
    )),
    CHECK (status IN ('pooled','bound','dead'))
  );
  CREATE TABLE session_resets (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL,
    mode       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE session_deletions (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL,
    mode            TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    created_at      INTEGER NOT NULL
  );
  CREATE TABLE session_turns (
    conversation_id TEXT PRIMARY KEY,
    first_turn_at   INTEGER NOT NULL
  );
  CREATE TABLE terminal_modes (
    id         TEXT PRIMARY KEY,
    type       TEXT NOT NULL,
    is_builtin INTEGER NOT NULL
  );
`)
raw.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run('t1', '{}')
raw.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run('t3', '{}')
// A user-defined provider declares the agent it wraps in `type`; a built-in chat
// mode's `type` names its engine too, but a built-in is its own agent.
for (const [id, type, builtin] of [
  ['my-claude', 'claude-code', 0],
  ['my-codex', 'codex', 0],
  ['claude-chat', 'claude-code', 1]
] as const) {
  raw
    .prepare('INSERT INTO terminal_modes (id, type, is_builtin) VALUES (?, ?, ?)')
    .run(id, type, builtin)
}

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
    return raw.transaction(() => ops.map((op) => raw.prepare(op.sql)[op.type](...op.params)))()
  }
} as unknown as SlayzoneDb

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Assert the new resolver agrees with the old ledger AND the expected value. */
async function parity(mode: string, expected: string | null, label: string): Promise<void> {
  const old = await getCurrentOld(db, 't1', mode)
  const neu = await getCurrentNew(db, 't1', mode)
  expect(old, `${label}: old resolver`).toBe(expected)
  expect(neu, `${label}: new resolver`).toBe(expected)
  expect(neu, `${label}: new/old resolver disagree`).toBe(old)
}

// Steps share one in-memory DB and run in declaration order; each test builds
// on the state the previous ones left behind.
describe('agent_sessions parity', () => {
  // 1. Latest honored row is current — both resolvers.
  test('latest honored', async () => {
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
    await parity('claude-code', 'C2', 'latest honored')
  })

  // 2. Foreign-observed never current.
  test('foreign-observed ignored', async () => {
    await sleep(2)
    await recordConversation(db, {
      taskId: 't1',
      mode: 'claude-code',
      conversationId: 'F1',
      origin: 'foreign-observed'
    })
    await parity('claude-code', 'C2', 'foreign-observed ignored')
  })

  // 3. Pending-spawn never current.
  test('pending-spawn ignored', async () => {
    await sleep(2)
    await recordPendingSpawn(db, {
      taskId: 't1',
      mode: 'claude-code',
      expectedSessionId: 'P1',
      usedResume: false
    })
    await parity('claude-code', 'C2', 'pending-spawn ignored')
  })

  // 4. Reset is a CUTOFF — modeled as a session_resets event for the new path.
  test('after reset, no later honored row → null', async () => {
    await sleep(2)
    await recordConversation(db, {
      taskId: 't1',
      mode: 'claude-code',
      conversationId: null,
      origin: 'manual-reset'
    })
    await parity('claude-code', null, 'after reset, no later honored row → null')
  })

  // The reset landed in session_resets, NOT agent_sessions.
  test('reset must be a session_resets row', () => {
    const resetRows = raw
      .prepare(`SELECT count(*) AS n FROM session_resets WHERE task_id='t1' AND mode='claude-code'`)
      .get() as { n: number }
    expect(resetRows.n).toBe(1)
  })

  test('manual-reset must never appear in agent_sessions', () => {
    const resetInSessions = raw
      .prepare(`SELECT count(*) AS n FROM agent_sessions WHERE origin='manual-reset'`)
      .get() as { n: number }
    expect(resetInSessions.n).toBe(0)
  })

  test('fresh row strictly after reset becomes current', async () => {
    await sleep(2)
    await recordConversation(db, {
      taskId: 't1',
      mode: 'claude-code',
      conversationId: 'C3',
      origin: 'slay-spawned-fresh'
    })
    // A fresh claude-code id is only resumable once it has taken a turn (Claude
    // writes no transcript before its first prompt) — see recordConversation.
    await markSessionFirstTurn(db, 'C3')
    await parity('claude-code', 'C3', 'fresh row strictly after reset becomes current')
  })

  // 5. History parity (minus the reset row, which is not a session). Old ledger
  //    has 6 rows (incl. manual-reset); new has the 5 sessions.
  test('old history should have 6 rows', async () => {
    expect(await listOld(db, 't1', 'claude-code')).toHaveLength(6)
  })

  test('new history should have 5 session rows', async () => {
    expect(await listNew(db, 't1', 'claude-code')).toHaveLength(5)
  })

  test('new history must not contain manual-reset', async () => {
    const newHist = await listNew(db, 't1', 'claude-code')
    expect(newHist.map((h) => h.origin)).not.toContain('manual-reset')
  })

  test('new history must include foreign + pending session rows', async () => {
    const origins = (await listNew(db, 't1', 'claude-code')).map((h) => h.origin)
    expect(origins).toContain('foreign-observed')
    expect(origins).toContain('pending-spawn')
  })

  // 6. findPendingSpawn (new) round-trips — null expected ("fresh" sentinel).
  let p1: Awaited<ReturnType<typeof findNew>>
  test('fresh pending row should be found via agent_sessions', async () => {
    await recordPendingSpawn(db, {
      taskId: 't1',
      mode: 'codex',
      expectedSessionId: null,
      usedResume: false
    })
    p1 = await findNew(db, 't1', 'codex')
    expect(p1).not.toBeNull()
  })

  test('expectedSessionId null preserved', () => {
    expect(p1?.expectedSessionId).toBeNull()
  })

  test('usedResume preserved', () => {
    expect(p1?.usedResume).toBe(false)
  })

  // 7. findPendingSpawn (new) with explicit id.
  let p2: Awaited<ReturnType<typeof findNew>>
  test('expected id round-tripped', async () => {
    await recordPendingSpawn(db, {
      taskId: 't1',
      mode: 'gemini',
      expectedSessionId: 'EXPECTED',
      usedResume: true
    })
    p2 = await findNew(db, 't1', 'gemini')
    expect(p2?.expectedSessionId).toBe('EXPECTED')
  })

  test('usedResume true preserved', () => {
    expect(p2?.usedResume).toBe(true)
  })

  // 8. prunePendingSpawns mirror — clears the shadow agent_sessions pending row.
  test('expected 1 pruned task_conversations row', async () => {
    const pruned = await prunePendingSpawns(db, { taskId: 't1', mode: 'codex' })
    expect(pruned).toBe(1)
  })

  test('codex pending must be gone from agent_sessions after prune', async () => {
    expect(await findNew(db, 't1', 'codex')).toBeNull()
  })

  test('gemini pending must still be present in agent_sessions', async () => {
    expect(await findNew(db, 't1', 'gemini')).not.toBeNull()
  })

  // 9. Cross-mode reset isolation — a reset on claude-code must not affect codex.
  test('unrelated mode unaffected by claude-code reset', async () => {
    await recordConversation(db, {
      taskId: 't1',
      mode: 'opencode',
      conversationId: 'O1',
      origin: 'slay-spawned-fresh'
    })
    await parity('opencode', 'O1', 'unrelated mode unaffected by claude-code reset')
  })

  // 10. Batched resolver parity (shared.ts attachCurrentConversationByMode) —
  //     the ROW_NUMBER window query over many (task, mode) pairs must agree
  //     with the single-row resolver for every pair. Seed a second task with
  //     its own reset + post-reset session.
  let batchedMap: Map<string, string | null>
  test('batched resolver agrees with single for every (task, mode) pair', async () => {
    await recordConversation(db, {
      taskId: 't2',
      mode: 'claude-code',
      conversationId: 'D1',
      origin: 'slay-spawned-fresh'
    })
    await sleep(2)
    await recordConversation(db, {
      taskId: 't2',
      mode: 'claude-code',
      conversationId: null,
      origin: 'manual-reset'
    })
    await sleep(2)
    await recordConversation(db, {
      taskId: 't2',
      mode: 'claude-code',
      conversationId: 'D2',
      origin: 'slay-spawned-resume'
    })
    await recordConversation(db, {
      taskId: 't2',
      mode: 'codex',
      conversationId: 'E1',
      origin: 'slay-spawned-fresh'
    })

    const ids = ['t1', 't2']
    const ph = ids.map(() => '?').join(',')
    const batched = await db.all<{
      task_id: string
      mode: string
      conversation_id: string | null
    }>(
      `WITH reset AS (
         SELECT task_id, mode, max(created_at) AS at FROM session_resets
         WHERE task_id IN (${ph}) GROUP BY task_id, mode
       ),
       ranked AS (
         SELECT s.task_id, s.mode, s.conversation_id,
           ROW_NUMBER() OVER (PARTITION BY s.task_id, s.mode ORDER BY ${OWNED_AT_SQL} DESC) AS rn
         FROM agent_sessions s
         LEFT JOIN reset r ON r.task_id = s.task_id AND r.mode = s.mode
         WHERE s.task_id IN (${ph})
           AND ${resumableSessionSql('r.at')}
       )
       SELECT task_id, mode, conversation_id FROM ranked WHERE rn = 1`,
      [...ids, ...ids]
    )
    batchedMap = new Map(batched.map((r) => [`${r.task_id}:${r.mode}`, r.conversation_id]))
    for (const [taskId, mode] of [
      ['t1', 'claude-code'],
      ['t1', 'opencode'],
      ['t2', 'claude-code'],
      ['t2', 'codex']
    ] as const) {
      const single = await getCurrentNew(db, taskId, mode)
      const batchedVal = batchedMap.get(`${taskId}:${mode}`) ?? null
      expect(batchedVal, `batched resolver disagrees with single for ${taskId}:${mode}`).toBe(
        single
      )
    }
  })

  // Spot-check the expected post-reset winner for t2.
  test('t2 claude-code should resolve to D2', () => {
    expect(batchedMap.get('t2:claude-code')).toBe('D2')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 11-13. Warm-pool resume regression — replays the real a426d99d timeline.
  //
  // A warm agent is pre-booted BEFORE any task needs it and bound minutes later.
  // Two things went wrong, both here:
  //   - the reset cutoff compared `created_at` (pre-boot) instead of bind time,
  //     so the session doing the actual work was excluded 2s before it started;
  //   - a pooled agent that never took a turn has no transcript on disk, so
  //     resuming its id can only ever fail (`No conversation found with session
  //     ID:`), and the app then force-reset the task to recover.
  // ───────────────────────────────────────────────────────────────────────────
  const T_POOL_A = 1785997631658 // 08:27:11 warm spawn (became the real session)
  const T_RESET = 1785997778737 //  08:29:38 reset cutoff
  const T_BIND_A = 1785997780096 // 08:29:40 adopted by the task — 2s AFTER the reset
  const T_TURN_A = 1785997902000 // 08:31:42 first UserPromptSubmit → transcript exists
  const T_POOL_B = 1785997798840 // 08:29:58 warm spawn (replenish) — never used
  const T_BIND_B = 1786002377676 // 09:46:17 adopted 77min later, still zero turns

  const at = (id: string, col: string, ms: number): void => {
    raw.prepare(`UPDATE agent_sessions SET ${col} = ? WHERE id = ?`).run(ms, id)
  }

  // 11. Cutoff is BIND time, not pre-boot time. A pre-booted-before-reset session
  //     that the task adopted after the reset is this task's session.
  test('session bound AFTER the reset must be honored even though it was pre-booted BEFORE it', async () => {
    // Warm agent A: pooled → confirmed → bound after the reset → took a turn.
    await recordSessionSpawn(db, {
      id: 'S_A',
      taskId: null,
      tabId: null,
      mode: 'claude-code',
      cwd: '/k',
      expectedConversationId: 'a85fd6e9',
      usedResume: false,
      status: 'pooled'
    })
    await confirmSessionConversation(db, { sessionId: 'S_A', observedConversationId: 'a85fd6e9' })
    at('S_A', 'created_at', T_POOL_A)

    // Warm agent B: pooled → confirmed → bound much later → NEVER took a turn.
    await recordSessionSpawn(db, {
      id: 'S_B',
      taskId: null,
      tabId: null,
      mode: 'claude-code',
      cwd: '/k',
      expectedConversationId: 'dd9c7775',
      usedResume: false,
      status: 'pooled'
    })
    await confirmSessionConversation(db, { sessionId: 'S_B', observedConversationId: 'dd9c7775' })
    at('S_B', 'created_at', T_POOL_B)

    raw
      .prepare(`INSERT INTO session_resets (id, task_id, mode, created_at) VALUES (?, ?, ?, ?)`)
      .run('r_a426', 't3', 'claude-code', T_RESET)

    await bindSessionToTask(db, { sessionId: 'S_A', taskId: 't3', tabId: 'tab3' })
    at('S_A', 'bound_at', T_BIND_A)
    await markSessionFirstTurn(db, 'a85fd6e9')
    raw
      .prepare(`UPDATE session_turns SET first_turn_at = ? WHERE conversation_id = ?`)
      .run(T_TURN_A, 'a85fd6e9')

    expect(await getCurrentNew(db, 't3', 'claude-code')).toBe('a85fd6e9')
  })

  // 12. A zero-turn session is not a resume target — even as the newest bind.
  //     `--resume` against it can only produce SESSION_NOT_FOUND.
  let afterAdopt: string | null
  test('a zero-turn pooled session must never become the resume target', async () => {
    await bindSessionToTask(db, { sessionId: 'S_B', taskId: 't3', tabId: 'tab3' })
    at('S_B', 'bound_at', T_BIND_B)
    afterAdopt = await getCurrentNew(db, 't3', 'claude-code')
    expect(afterAdopt).not.toBe('dd9c7775')
  })

  test('adopting an unused warm agent must not orphan the live conversation', () => {
    expect(afterAdopt).toBe('a85fd6e9')
  })

  // 13. Once it takes a turn it has a transcript — and wins on bind time.
  test('after its first turn the most recently bound session becomes current', async () => {
    await markSessionFirstTurn(db, 'dd9c7775')
    expect(await getCurrentNew(db, 't3', 'claude-code')).toBe('dd9c7775')
  })

  // 14. markSessionFirstTurn is write-once — a later turn never moves the mark.
  //     It means "has content", not "was last active"; if it drifted, readers
  //     would start racing it as an mtime.
  test('first_turn_at must be write-once', async () => {
    const markOf = (id: string): number =>
      (
        raw
          .prepare(`SELECT first_turn_at AS t FROM session_turns WHERE conversation_id = ?`)
          .get(id) as { t: number }
      ).t
    const firstMark = markOf('dd9c7775')
    await markSessionFirstTurn(db, 'dd9c7775')
    expect(markOf('dd9c7775')).toBe(firstMark)
  })

  // 15. Turn tracking is a property of the AGENT a mode runs, not of the mode id.
  //     A user-defined provider wrapping claude-code reports its id at launch,
  //     before any transcript exists, exactly like claude-code itself — proving it
  //     at confirm made the next restart resume an id `--resume` cannot find.
  const isProven = (id: string): boolean =>
    raw.prepare('SELECT 1 FROM session_turns WHERE conversation_id = ?').get(id) !== undefined
  const confirmFresh = async (sessionId: string, mode: string, cid: string): Promise<void> => {
    await recordSessionSpawn(db, {
      id: sessionId,
      taskId: 't1',
      tabId: 'tab1',
      mode,
      cwd: '/k',
      expectedConversationId: cid,
      usedResume: false,
      status: 'bound'
    })
    await confirmSessionConversation(db, { sessionId, observedConversationId: cid })
  }
  test('a fresh session of a provider wrapping claude-code must stay unproven until its first turn', async () => {
    await confirmFresh('S_CUSTOM', 'my-claude', 'c0ffee01')
    expect(isProven('c0ffee01')).toBe(false)
  })

  // Built-in chat mode: its own agent, so unchanged (proven at confirm).
  test('a built-in chat mode must keep being proven at confirm', async () => {
    await confirmFresh('S_CHAT', 'claude-chat', 'c0ffee02')
    expect(isProven('c0ffee02')).toBe(true)
  })

  // A provider wrapping an agent whose turns slay cannot observe: proven at confirm.
  test('a provider wrapping a non-turn-tracked agent is proven at confirm', async () => {
    await confirmFresh('S_CUSTOM_CODEX', 'my-codex', 'c0ffee03')
    expect(isProven('c0ffee03')).toBe(true)
  })
})
