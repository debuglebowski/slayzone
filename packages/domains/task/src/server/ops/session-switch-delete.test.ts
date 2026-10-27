/**
 * Session SWITCH (`user-selected` origin, migration v156) + session DELETE
 * (`session_deletions` tombstones, migration v157).
 *
 * Runs against the FULL production migration chain on a real better-sqlite3
 * handle, so the CHECK constraints, indexes and FKs under test are the ones a
 * live store gets — not a hand-written harness schema that can drift from
 * migrations.ts. v156 is a table REBUILD (SQLite can't ALTER a CHECK in place),
 * which is the riskiest migration shape here, so the rebuild assertions mirror
 * `in-band-clear-migration.test.ts`: rows survive byte-identically, columns keep
 * their order, every index comes back, the FK still cascades.
 *
 * Runs under vitest on Electron's node (packages/shared/test-utils/
 * vitest.harness.config.ts) — better-sqlite3's native ABI matches Electron's
 * node only.
 */
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { DB_PRAGMAS, type BatchOp, type SlayzoneDb } from '@slayzone/platform'
import {
  LATEST_MIGRATION_VERSION,
  migrations,
  runMigrations
} from '@slayzone/transport/db-bootstrap'
import { ALL_ORIGINS, HONORED_ORIGINS } from '@slayzone/task/shared'
import { recordConversation } from './task-conversations.js'
import {
  deleteSession,
  getCurrentConversationId,
  isHonoredConversation,
  listTaskSessions,
  markSessionFirstTurn
} from './agent-sessions.js'

/** Fresh in-memory DB with the full production migration chain applied. */
function migratedDb(): Database.Database {
  const raw = new Database(':memory:')
  for (const pragma of DB_PRAGMAS) raw.pragma(pragma)
  runMigrations(raw)
  return raw
}

/** Re-run one migration's `up` against an already-migrated handle. See the twin
 *  helper in in-band-clear-migration.test.ts for why this is not a user_version
 *  rewind. */
function replayMigration(raw: Database.Database, version: number): void {
  const m = migrations.find((x) => x.version === version)
  if (!m) throw new Error(`migration ${version} not found`)
  raw.transaction(() => m.up(raw))()
}

/** SlayzoneDb bridge over a raw handle — the ops take the async interface. */
function bridge(raw: Database.Database): SlayzoneDb {
  return {
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
    },
    prepare(sql: string) {
      const stmt = raw.prepare(sql)
      return {
        async get(...params: unknown[]) {
          return stmt.get(...params)
        },
        async all(...params: unknown[]) {
          return stmt.all(...params)
        },
        async run(...params: unknown[]) {
          const r = stmt.run(...params)
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
        }
      }
    }
  } as unknown as SlayzoneDb
}

function seedTask(raw: Database.Database, taskId: string): void {
  raw
    .prepare(`INSERT OR IGNORE INTO projects (id, name, color) VALUES (?, ?, ?)`)
    .run('p1', 'P', '#000')
  raw.prepare(`INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)`).run(taskId, 'p1', 'T')
}

function indexNames(raw: Database.Database, table: string): string[] {
  return (
    raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
      .all(table) as { name: string }[]
  )
    .map((r) => r.name)
    .filter((n) => !n.startsWith('sqlite_autoindex'))
}

function columnNames(raw: Database.Database, table: string): string[] {
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name)
}

function insConv(raw: Database.Database): Database.Statement {
  return raw.prepare(
    `INSERT INTO task_conversations (id, task_id, mode, conversation_id, origin, pending_meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
}
function insSession(raw: Database.Database): Database.Statement {
  return raw.prepare(
    `INSERT INTO agent_sessions
       (id, mode, cwd, task_id, conversation_id, origin, status, pending_meta,
        created_at, bound_at, tab_id, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
}
function insPrompt(raw: Database.Database): Database.Statement {
  return raw.prepare(
    `INSERT INTO agent_prompts (id, task_id, agent_id, cli_session_id, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
}

const M = 'claude-code'

const deadSession = (
  id: string,
  mode: string,
  taskId: string,
  conversationId: string,
  origin: string,
  createdAt: number
): unknown[] => [
  id,
  mode,
  null,
  taskId,
  conversationId,
  origin,
  'dead',
  null,
  createdAt,
  null,
  null,
  null
]

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 2))

// ── v156: the `user-selected` origin ──────────────────────────────────────
test('LATEST_MIGRATION_VERSION should be >= 157', () => {
  expect(LATEST_MIGRATION_VERSION).toBeGreaterThanOrEqual(157)
})

test('user-selected must be an HONORED origin', () => {
  expect(HONORED_ORIGINS.has('user-selected')).toBe(true)
})

// 1. Both rebuilt tables accept the new origin; the CHECK was widened, not dropped.
describe('v156 widens the origin CHECK', () => {
  let raw: Database.Database
  beforeAll(() => {
    raw = migratedDb()
    seedTask(raw, 't1')
  })
  afterAll(() => raw.close())

  test('task_conversations must accept user-selected', () => {
    expect(() =>
      insConv(raw).run('tc1', 't1', M, 'conv-a', 'user-selected', null, 1000)
    ).not.toThrow()
  })

  test('agent_sessions must accept user-selected', () => {
    expect(() =>
      insSession(raw).run(...deadSession('as1', M, 't1', 'conv-a', 'user-selected', 1000))
    ).not.toThrow()
  })

  test('task_conversations must still reject an unknown origin', () => {
    expect(() => insConv(raw).run('tc-bad', 't1', M, 'c', 'totally-made-up', null, 1)).toThrow(
      /CHECK constraint failed/
    )
  })

  test('agent_sessions must still reject an unknown origin', () => {
    expect(() =>
      insSession(raw).run(...deadSession('as-bad', M, 't1', 'c', 'totally-made-up', 1))
    ).toThrow(/CHECK constraint failed/)
  })
})

// 2. TS enum ↔ SQL CHECK sync: every ConversationOrigin value inserts.
describe('TS enum ↔ SQL CHECK sync', () => {
  let raw: Database.Database
  beforeAll(() => {
    raw = migratedDb()
    seedTask(raw, 't1')
  })
  afterAll(() => raw.close())

  const origins = [...ALL_ORIGINS.entries()]
  test.each(origins)("origin #%i '%s' must satisfy the task_conversations CHECK", (i, origin) => {
    expect(() => insConv(raw).run(`tc-${i}`, 't1', 'm', `c-${i}`, origin, null, i)).not.toThrow()
  })

  // agent_sessions has no 'manual-reset' (a reset is a session_resets row).
  test.each(origins.filter(([, o]) => o !== 'manual-reset'))(
    "origin #%i '%s' must satisfy the agent_sessions CHECK",
    (i, origin) => {
      expect(() =>
        insSession(raw).run(...deadSession(`as-${i}`, 'm', 't1', `c-${i}`, origin, i))
      ).not.toThrow()
    }
  )
})

// 3. Rebuild integrity: columns keep their order, every index returns, the FK
//    still cascades (v156 runs with foreign_keys OFF), and a replayed rebuild
//    over populated tables preserves rows byte-identically.
describe('v156 rebuild integrity', () => {
  let raw: Database.Database
  beforeAll(() => {
    raw = migratedDb()
  })
  afterAll(() => raw.close())

  test('foreign_keys must be back ON', () => {
    expect(raw.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  test('agent_sessions columns keep their order', () => {
    expect(columnNames(raw, 'agent_sessions').join(',')).toBe(
      'id,mode,cwd,task_id,conversation_id,origin,status,pending_meta,created_at,bound_at,tab_id,ended_at'
    )
  })

  test('task_conversations columns keep their order', () => {
    expect(columnNames(raw, 'task_conversations').join(',')).toBe(
      'id,task_id,mode,conversation_id,origin,pending_meta,created_at'
    )
  })

  test.each([
    'agent_sessions_task',
    'agent_sessions_pool',
    'agent_sessions_pending',
    'agent_sessions_tab'
  ])('agent_sessions has index %s after v156', (idx) => {
    expect(indexNames(raw, 'agent_sessions')).toContain(idx)
  })

  test.each(['task_conversations_lookup', 'task_conversations_pending'])(
    'task_conversations has index %s after v156',
    (idx) => {
      expect(indexNames(raw, 'task_conversations')).toContain(idx)
    }
  )

  describe('replayed rebuild over populated tables', () => {
    let before: { sessions: unknown[]; convs: unknown[] }
    beforeAll(() => {
      seedTask(raw, 't1')
      insSession(raw).run(
        's-full',
        M,
        '/w',
        't1',
        'c1',
        'slay-spawned-resume',
        'dead',
        '{"usedResume":true,"spawnedAt":5}',
        100,
        110,
        'tab-1',
        120
      )
      insSession(raw).run(
        's-pooled',
        M,
        null,
        null,
        null,
        'pending-spawn',
        'pooled',
        null,
        200,
        null,
        null,
        null
      )
      insConv(raw).run('tc-full', 't1', M, 'c1', 'foreign-observed', '{"a":1}', 300)
      insConv(raw).run('tc-null', 't1', M, null, 'manual-reset', null, 400)
      before = {
        sessions: raw.prepare(`SELECT * FROM agent_sessions ORDER BY id`).all(),
        convs: raw.prepare(`SELECT * FROM task_conversations ORDER BY id`).all()
      }
      // Re-run v156's rebuild against populated tables — the data-copy path a live
      // store takes on upgrade. Run that migration's `up` directly rather than
      // rewinding `user_version`: a rewind re-runs every LATER migration too, and
      // those are not idempotent by design (a plain `ALTER TABLE … ADD COLUMN`
      // throws on a second pass, and SQLite has no `ADD COLUMN IF NOT EXISTS`).
      replayMigration(raw, 156)
    })

    test('agent_sessions rows unchanged across the v156 rebuild', () => {
      expect(before.sessions).toHaveLength(2)
      expect(raw.prepare(`SELECT * FROM agent_sessions ORDER BY id`).all()).toStrictEqual(
        before.sessions
      )
    })

    test('task_conversations rows unchanged across the v156 rebuild', () => {
      expect(before.convs).toHaveLength(2)
      expect(raw.prepare(`SELECT * FROM task_conversations ORDER BY id`).all()).toStrictEqual(
        before.convs
      )
    })

    test('agent_sessions_tab must survive a replayed rebuild', () => {
      expect(indexNames(raw, 'agent_sessions')).toContain('agent_sessions_tab')
    })
  })
})

// ── v157: the session_deletions tombstone table ───────────────────────────
describe('v157 session_deletions', () => {
  let raw: Database.Database
  beforeAll(() => {
    raw = migratedDb()
  })
  afterAll(() => raw.close())

  test('session_deletions_lookup index must exist', () => {
    expect(indexNames(raw, 'session_deletions')).toContain('session_deletions_lookup')
  })

  test('session_deletions columns', () => {
    expect(columnNames(raw, 'session_deletions').join(',')).toBe(
      'id,task_id,mode,conversation_id,created_at'
    )
  })

  test('session_deletions must cascade-delete with its task', () => {
    seedTask(raw, 't1')
    raw
      .prepare(
        `INSERT INTO session_deletions (id, task_id, mode, conversation_id, created_at)
         VALUES ('d1', 't1', ?, 'c1', 1)`
      )
      .run(M)
    raw.prepare(`DELETE FROM tasks WHERE id = 't1'`).run()
    const n = (raw.prepare(`SELECT count(*) AS n FROM session_deletions`).get() as { n: number }).n
    expect(n).toBe(0)
  })
})

// ── Switch: a user-selected row makes an OLDER session current again ──────
// Steps share one DB and run in declaration order.
describe('switch', () => {
  let raw: Database.Database
  let db: SlayzoneDb
  beforeAll(async () => {
    raw = migratedDb()
    seedTask(raw, 't1')
    db = bridge(raw)
    await recordConversation(db, {
      taskId: 't1',
      mode: M,
      conversationId: 'A',
      origin: 'slay-spawned-fresh'
    })
    await tick()
    await recordConversation(db, {
      taskId: 't1',
      mode: M,
      conversationId: 'B',
      origin: 'slay-spawned-fresh'
    })
    // A fresh claude-code id is only resumable once it has taken a turn (Claude
    // writes no transcript before its first prompt) — see recordConversation.
    await markSessionFirstTurn(db, 'A')
    await markSessionFirstTurn(db, 'B')
  })
  afterAll(() => raw.close())

  test('newest session should start current', async () => {
    expect(await getCurrentConversationId(db, 't1', M)).toBe('B')
  })

  test('A must be switchable', async () => {
    expect(await isHonoredConversation(db, 't1', M, 'A')).toBe(true)
  })

  test('unknown id must not be switchable', async () => {
    expect(await isHonoredConversation(db, 't1', M, 'nope')).toBe(false)
  })

  test("another task's id must not be switchable", async () => {
    expect(await isHonoredConversation(db, 't2', M, 'A')).toBe(false)
  })

  test('switch must make A current', async () => {
    await tick()
    await recordConversation(db, {
      taskId: 't1',
      mode: M,
      conversationId: 'A',
      origin: 'user-selected'
    })
    expect(await getCurrentConversationId(db, 't1', M)).toBe('A')
  })

  test('switch must not create a new session', async () => {
    expect(await listTaskSessions(db, 't1', M)).toHaveLength(2)
  })

  test('A must be flagged current', async () => {
    const sessions = await listTaskSessions(db, 't1', M)
    expect(sessions.find((s) => s.conversationId === 'A')?.isCurrent).toBe(true)
  })

  test("a switch must not rewrite the session's recorded provenance", async () => {
    const sessions = await listTaskSessions(db, 't1', M)
    expect(sessions.find((s) => s.conversationId === 'A')?.origin).toBe('slay-spawned-fresh')
  })

  // The legacy mirror consumers still read must follow the switch.
  test('legacy column must mirror the switch', () => {
    const t = raw
      .prepare(`SELECT claude_conversation_id AS c FROM tasks WHERE id = 't1'`)
      .get() as {
      c: string
    }
    expect(t.c).toBe('A')
  })

  // A switch after a reset cutoff still works (the new row is past the cutoff).
  test('reset must clear current', async () => {
    await recordConversation(db, {
      taskId: 't1',
      mode: M,
      conversationId: null,
      origin: 'manual-reset'
    })
    expect(await getCurrentConversationId(db, 't1', M)).toBeNull()
  })

  test('switch must work after a reset cutoff', async () => {
    await tick()
    await recordConversation(db, {
      taskId: 't1',
      mode: M,
      conversationId: 'B',
      origin: 'user-selected'
    })
    expect(await getCurrentConversationId(db, 't1', M)).toBe('B')
  })
})

// ── Delete: tombstone hides the session everywhere, current is protected ──
// Steps share one DB and run in declaration order.
describe('delete', () => {
  let raw: Database.Database
  let db: SlayzoneDb
  beforeAll(async () => {
    raw = migratedDb()
    seedTask(raw, 't1')
    db = bridge(raw)
    await recordConversation(db, {
      taskId: 't1',
      mode: M,
      conversationId: 'A',
      origin: 'slay-spawned-fresh'
    })
    await tick()
    await recordConversation(db, {
      taskId: 't1',
      mode: M,
      conversationId: 'B',
      origin: 'slay-spawned-fresh'
    })
    // A fresh claude-code id is only resumable once it has taken a turn (Claude
    // writes no transcript before its first prompt) — see recordConversation.
    await markSessionFirstTurn(db, 'A')
    await markSessionFirstTurn(db, 'B')
    insPrompt(raw).run('p-a', 't1', M, 'A', 'hello from A', 1)
    insPrompt(raw).run('p-b', 't1', M, 'B', 'hello from B', 2)
  })
  afterAll(() => raw.close())

  // The current session is NOT deletable — the live agent is running on it.
  test('deleting the CURRENT session must be refused', async () => {
    expect(await deleteSession(db, 't1', M, 'B')).toBe(false)
  })

  test('refused delete must not tombstone', async () => {
    expect(await listTaskSessions(db, 't1', M)).toHaveLength(2)
  })

  test('deleting a non-current session must succeed', async () => {
    expect(await deleteSession(db, 't1', M, 'A')).toBe(true)
  })

  test('A must be gone from the list', async () => {
    const after = await listTaskSessions(db, 't1', M)
    expect(after.map((s) => s.conversationId)).toEqual(['B'])
  })

  test('a deleted session must not be switchable', async () => {
    expect(await isHonoredConversation(db, 't1', M, 'A')).toBe(false)
  })
  // (the Messages-sidebar side of the tombstone — listPromptsForTask — is
  // asserted in agent-turns/src/server/prompt-capture.test.ts, which owns that op)

  // Deleting is scoped: the same conversation id under another mode survives.
  test('a tombstone must not leak across modes', async () => {
    await recordConversation(db, {
      taskId: 't1',
      mode: 'codex',
      conversationId: 'A',
      origin: 'slay-spawned-fresh'
    })
    expect(await getCurrentConversationId(db, 't1', 'codex')).toBe('A')
  })

  // Defence in depth: even if a later honored row named a deleted conversation,
  // it must never become the resume target.
  test('a deleted conversation must never resolve as current', async () => {
    await tick()
    await recordConversation(db, {
      taskId: 't1',
      mode: M,
      conversationId: 'A',
      origin: 'in-band-clear'
    })
    expect(await getCurrentConversationId(db, 't1', M)).toBe('B')
  })
})
