import { describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import type { BatchOp, SlayzoneDb } from '@slayzone/platform'
import { ALL_ORIGINS } from '@slayzone/task-contracts'
import {
  recordConversation,
  getCurrentConversationId,
  listConversationHistory,
  recordPendingSpawn,
  findPendingSpawn,
  prunePendingSpawns
} from './task-conversations.js'

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
      'in-band-clear',
      'user-selected',
      'handoff',
      'slay-spawned-fork',
      'cas-repoint-heal',
      'legacy-migration',
      'foreign-observed',
      'manual-reset',
      'pending-spawn'
    ))
  );
  -- v147 first-class agent-session tables: recordConversation triple-writes
  -- into these during the transition slice (see plans/agent-sessions.md).
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
      'slay-spawned-fresh','slay-spawned-resume','in-band-clear','user-selected',
      'handoff','slay-spawned-fork',
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Steps share one in-memory DB and run in declaration order; each test builds
// on the state the previous ones left behind.
describe('task_conversations', () => {
  // 1. Honored read returns latest honored row.
  test('latest honored row should be current', async () => {
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
    expect(await getCurrentConversationId(db, 't1', 'claude-code')).toBe('C2')
  })

  // 2. Foreign-observed rows are NEVER current — even when latest.
  test('foreign-observed must not become current — last honored (C2) should win', async () => {
    await sleep(2)
    await recordConversation(db, {
      taskId: 't1',
      mode: 'claude-code',
      conversationId: 'F1',
      origin: 'foreign-observed'
    })
    expect(await getCurrentConversationId(db, 't1', 'claude-code')).toBe('C2')
  })

  // 3. Pending-spawn rows are NEVER current.
  test('pending-spawn must not become current', async () => {
    await sleep(2)
    await recordPendingSpawn(db, {
      taskId: 't1',
      mode: 'claude-code',
      expectedSessionId: 'P1',
      usedResume: false
    })
    expect(await getCurrentConversationId(db, 't1', 'claude-code')).toBe('C2')
  })

  // 4. Manual-reset is a CUTOFF — later honored rows become current again,
  //    but earlier honored rows (C1/C2) are hidden.
  test('after manual-reset with no later honored row, current must be NULL', async () => {
    await sleep(2)
    await recordConversation(db, {
      taskId: 't1',
      mode: 'claude-code',
      conversationId: null,
      origin: 'manual-reset'
    })
    expect(await getCurrentConversationId(db, 't1', 'claude-code')).toBeNull()
  })

  test('a fresh row strictly after manual-reset becomes current', async () => {
    await sleep(2)
    await recordConversation(db, {
      taskId: 't1',
      mode: 'claude-code',
      conversationId: 'C3',
      origin: 'slay-spawned-fresh'
    })
    expect(await getCurrentConversationId(db, 't1', 'claude-code')).toBe('C3')
  })

  // 5. listConversationHistory returns every row including foreign + pending.
  test('audit history should have all 6 rows', async () => {
    expect(await listConversationHistory(db, 't1', 'claude-code')).toHaveLength(6)
  })

  test('audit history must include foreign + pending rows', async () => {
    const origins = (await listConversationHistory(db, 't1', 'claude-code')).map((h) => h.origin)
    expect(origins).toContain('foreign-observed')
    expect(origins).toContain('pending-spawn')
  })

  // 6. findPendingSpawn round-trip — null expected ("fresh" sentinel).
  let p1: Awaited<ReturnType<typeof findPendingSpawn>>
  test('fresh pending row should be found', async () => {
    await recordPendingSpawn(db, {
      taskId: 't1',
      mode: 'codex',
      expectedSessionId: null,
      usedResume: false
    })
    p1 = await findPendingSpawn(db, 't1', 'codex')
    expect(p1).not.toBeNull()
  })

  test('expectedSessionId should be null', () => {
    expect(p1?.expectedSessionId).toBeNull()
  })

  test('usedResume preserved', () => {
    expect(p1?.usedResume).toBe(false)
  })

  // 7. findPendingSpawn with explicit id.
  let p2: Awaited<ReturnType<typeof findPendingSpawn>>
  test('expected id round-tripped', async () => {
    await recordPendingSpawn(db, {
      taskId: 't1',
      mode: 'gemini',
      expectedSessionId: 'EXPECTED',
      usedResume: true
    })
    p2 = await findPendingSpawn(db, 't1', 'gemini')
    expect(p2?.expectedSessionId).toBe('EXPECTED')
  })

  test('usedResume true preserved', () => {
    expect(p2?.usedResume).toBe(true)
  })

  // 7b. Phase 2: TTL window for null-expected pending rows is much tighter
  //     (30 s) than for explicit-expected (10 min). Simulate by inserting a
  //     synthetic null-expected row 60 s in the past — findPendingSpawn must
  //     not return it. An explicit-expected row at the same age must still be
  //     returned (10-min window).
  const past60s = Date.now() - 60_000
  test('60s-old null-expected pending must be outside the tight TTL window', async () => {
    raw
      .prepare(
        `INSERT INTO task_conversations
           (id, task_id, mode, conversation_id, origin, pending_meta, created_at)
         VALUES (?, 't1', 'qwen-code', NULL, 'pending-spawn', ?, ?)`
      )
      .run(
        'stale-null-expected',
        JSON.stringify({ usedResume: false, spawnedAt: past60s }),
        past60s
      )
    expect(await findPendingSpawn(db, 't1', 'qwen-code')).toBeNull()
  })

  test('60s-old explicit-expected pending must still be inside the 10-min window', async () => {
    raw
      .prepare(
        `INSERT INTO task_conversations
           (id, task_id, mode, conversation_id, origin, pending_meta, created_at)
         VALUES (?, 't1', 'qwen-code', 'KEEP', 'pending-spawn', ?, ?)`
      )
      .run(
        'fresh-explicit-expected',
        JSON.stringify({ usedResume: false, spawnedAt: past60s }),
        past60s
      )
    const p3 = await findPendingSpawn(db, 't1', 'qwen-code')
    expect(p3?.expectedSessionId).toBe('KEEP')
  })

  // 8. prunePendingSpawns by scope removes pending rows for that (task, mode).
  test('expected 1 pruned row', async () => {
    const pruned = await prunePendingSpawns(db, { taskId: 't1', mode: 'codex' })
    expect(pruned).toBe(1)
  })

  test('codex pending should be gone after prune', async () => {
    expect(await findPendingSpawn(db, 't1', 'codex')).toBeNull()
  })

  test('gemini pending should still be present', async () => {
    expect(await findPendingSpawn(db, 't1', 'gemini')).not.toBeNull()
  })

  // 9. ENUM/CHECK sync — every value in ALL_ORIGINS INSERTs cleanly. This
  //    catches drift between the TS enum and the SQL CHECK constraint.
  test.each([...ALL_ORIGINS])("origin '%s' INSERTs cleanly (enum/CHECK sync)", async (origin) => {
    await recordConversation(db, {
      taskId: 't1',
      mode: '__enum_sync__',
      conversationId: origin === 'manual-reset' ? null : `id-${origin}`,
      origin,
      pendingMeta:
        origin === 'pending-spawn' ? { usedResume: false, spawnedAt: Date.now() } : undefined
    })
  })

  // 10. Legacy dual-write — honored rows write to provider_config + legacy col.
  const readTask = () =>
    raw
      .prepare('SELECT provider_config, claude_conversation_id FROM tasks WHERE id = ?')
      .get('t1') as {
      provider_config: string
      claude_conversation_id: string | null
    }
  test('legacy column must be dual-written for honored origins', async () => {
    await recordConversation(db, {
      taskId: 't1',
      mode: 'claude-code',
      conversationId: 'LEG1',
      origin: 'slay-spawned-fresh'
    })
    expect(readTask().claude_conversation_id).toBe('LEG1')
  })

  test('provider_config JSON must be dual-written', () => {
    expect(readTask().provider_config).toContain('LEG1')
  })

  // 10b. Phase 1: a `manual-reset` for the same (task, mode) clears the legacy
  //      JSON field AND the legacy column so live consumers immediately stop
  //      seeing the broken binding. Foreign-observed (tested below) must NOT
  //      clear; the two have opposite semantics.
  const parsedConfig = () =>
    JSON.parse(readTask().provider_config) as Record<
      string,
      { conversationId?: string | null; chatConversationId?: string | null }
    >
  test('manual-reset must clear the legacy *_conversation_id column', async () => {
    await recordConversation(db, {
      taskId: 't1',
      mode: 'claude-code',
      conversationId: null,
      origin: 'manual-reset'
    })
    expect(readTask().claude_conversation_id).toBeNull()
  })

  test('manual-reset must clear provider_config.{mode}.conversationId', () => {
    expect(parsedConfig()['claude-code']?.conversationId ?? null).toBeNull()
  })

  test('manual-reset must clear provider_config.{mode}.chatConversationId', () => {
    expect(parsedConfig()['claude-code']?.chatConversationId ?? null).toBeNull()
  })

  // 11. Foreign / pending writes do NOT touch the legacy field.
  test('foreign-observed must NOT mutate the legacy field', async () => {
    const beforeLegacy = readTask().claude_conversation_id
    await recordConversation(db, {
      taskId: 't1',
      mode: 'claude-code',
      conversationId: 'FORE1',
      origin: 'foreign-observed'
    })
    expect(readTask().claude_conversation_id).toBe(beforeLegacy)
  })

  // 12. Resumability proof (v158). Claude fires SessionStart at LAUNCH, before
  //     it writes any transcript, so a fresh claude-code id must stay unproven
  //     until a real turn — else an agent that never got a prompt is resumed
  //     after restart → "No conversation found" → false "session expired".
  const proven = (cid: string): boolean =>
    raw.prepare('SELECT 1 FROM session_turns WHERE conversation_id = ?').get(cid) !== undefined
  test('fresh claude-code id must stay unproven until its first turn', async () => {
    await recordConversation(db, {
      taskId: 'tp',
      mode: 'claude-code',
      conversationId: 'FRESH-CLAUDE',
      origin: 'slay-spawned-fresh'
    })
    expect(proven('FRESH-CLAUDE')).toBe(false)
  })

  test('a resume proves itself at write', async () => {
    await recordConversation(db, {
      taskId: 'tp',
      mode: 'claude-code',
      conversationId: 'RESUMED-CLAUDE',
      origin: 'slay-spawned-resume'
    })
    expect(proven('RESUMED-CLAUDE')).toBe(true)
  })

  test('non-turn-tracked mode is proven at write', async () => {
    await recordConversation(db, {
      taskId: 'tp',
      mode: 'codex',
      conversationId: 'FRESH-CODEX',
      origin: 'slay-spawned-fresh'
    })
    expect(proven('FRESH-CODEX')).toBe(true)
  })

  // 13. Turn tracking follows the AGENT a mode runs. A user-defined provider
  //     wrapping claude-code (the hook path records it under its OWN mode) must
  //     stay unproven like claude-code — proving it at write made the next
  //     restart resume an id with no transcript.
  test('fresh id of a provider wrapping claude-code must stay unproven until its first turn', async () => {
    await recordConversation(db, {
      taskId: 'tp',
      mode: 'my-claude',
      conversationId: 'FRESH-MY-CLAUDE',
      origin: 'slay-spawned-fresh'
    })
    expect(proven('FRESH-MY-CLAUDE')).toBe(false)
  })

  test('a provider wrapping a non-turn-tracked agent is proven at write', async () => {
    await recordConversation(db, {
      taskId: 'tp',
      mode: 'my-codex',
      conversationId: 'FRESH-MY-CODEX',
      origin: 'slay-spawned-fresh'
    })
    expect(proven('FRESH-MY-CODEX')).toBe(true)
  })

  // A built-in chat mode is its own agent — unchanged, although its `type` is claude-code.
  test('a built-in chat mode must keep being proven at write', async () => {
    await recordConversation(db, {
      taskId: 'tp',
      mode: 'claude-chat',
      conversationId: 'FRESH-CLAUDE-CHAT',
      origin: 'slay-spawned-fresh',
      legacyJsonField: 'chatConversationId'
    })
    expect(proven('FRESH-CLAUDE-CHAT')).toBe(true)
  })
})
