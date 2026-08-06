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
 * Plain asserts + the electron strict loader (NOT vitest) — better-sqlite3's
 * native ABI matches Electron's node only. See in-band-clear-migration.test.ts.
 */
import Database from 'better-sqlite3'
import { DB_PRAGMAS, type BatchOp, type SlayzoneDb } from '@slayzone/platform'
import { LATEST_MIGRATION_VERSION, migrations, runMigrations } from '@slayzone/transport/db-bootstrap'
import { ALL_ORIGINS, HONORED_ORIGINS } from '@slayzone/task/shared'
import { recordConversation } from './task-conversations.js'
import {
  deleteSession,
  getCurrentConversationId,
  isHonoredConversation,
  listTaskSessions
} from './agent-sessions.js'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    failures++
  }
}
function assertThrows(fn: () => void, msg: string): void {
  try {
    fn()
    console.error('FAIL:', msg, '— expected a throw, got none')
    failures++
  } catch {
    /* expected */
  }
}
function assertNoThrow(fn: () => void, msg: string): void {
  try {
    fn()
  } catch (e) {
    console.error('FAIL:', msg, '—', (e as Error).message)
    failures++
  }
}

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

async function main(): Promise<void> {
  // ── v156: the `user-selected` origin ──────────────────────────────────────
  assert(LATEST_MIGRATION_VERSION >= 157, 'LATEST_MIGRATION_VERSION should be >= 157')
  assert(HONORED_ORIGINS.has('user-selected'), 'user-selected must be an HONORED origin')

  // 1. Both rebuilt tables accept the new origin; the CHECK was widened, not dropped.
  {
    const raw = migratedDb()
    seedTask(raw, 't1')
    assertNoThrow(
      () => insConv(raw).run('tc1', 't1', M, 'conv-a', 'user-selected', null, 1000),
      'task_conversations must accept user-selected'
    )
    assertNoThrow(
      () =>
        insSession(raw).run(
          'as1', M, null, 't1', 'conv-a', 'user-selected', 'dead', null, 1000, null, null, null
        ),
      'agent_sessions must accept user-selected'
    )
    assertThrows(
      () => insConv(raw).run('tc-bad', 't1', M, 'c', 'totally-made-up', null, 1),
      'task_conversations must still reject an unknown origin'
    )
    assertThrows(
      () =>
        insSession(raw).run(
          'as-bad', M, null, 't1', 'c', 'totally-made-up', 'dead', null, 1, null, null, null
        ),
      'agent_sessions must still reject an unknown origin'
    )
    raw.close()
  }

  // 2. TS enum ↔ SQL CHECK sync: every ConversationOrigin value inserts.
  {
    const raw = migratedDb()
    seedTask(raw, 't1')
    for (const [i, origin] of ALL_ORIGINS.entries()) {
      assertNoThrow(
        () => insConv(raw).run(`tc-${i}`, 't1', 'm', `c-${i}`, origin, null, i),
        `origin '${origin}' must satisfy the task_conversations CHECK`
      )
      // agent_sessions has no 'manual-reset' (a reset is a session_resets row).
      if (origin === 'manual-reset') continue
      assertNoThrow(
        () =>
          insSession(raw).run(
            `as-${i}`, 'm', null, 't1', `c-${i}`, origin, 'dead', null, i, null, null, null
          ),
        `origin '${origin}' must satisfy the agent_sessions CHECK`
      )
    }
    raw.close()
  }

  // 3. Rebuild integrity: columns keep their order, every index returns, the FK
  //    still cascades (v156 runs with foreign_keys OFF), and a replayed rebuild
  //    over populated tables preserves rows byte-identically.
  {
    const raw = migratedDb()
    assert(raw.pragma('foreign_keys', { simple: true }) === 1, 'foreign_keys must be back ON')
    assert(
      columnNames(raw, 'agent_sessions').join(',') ===
        'id,mode,cwd,task_id,conversation_id,origin,status,pending_meta,created_at,bound_at,tab_id,ended_at',
      `agent_sessions columns drifted: ${columnNames(raw, 'agent_sessions').join(',')}`
    )
    assert(
      columnNames(raw, 'task_conversations').join(',') ===
        'id,task_id,mode,conversation_id,origin,pending_meta,created_at',
      `task_conversations columns drifted: ${columnNames(raw, 'task_conversations').join(',')}`
    )
    for (const idx of [
      'agent_sessions_task',
      'agent_sessions_pool',
      'agent_sessions_pending',
      'agent_sessions_tab'
    ]) {
      const have = indexNames(raw, 'agent_sessions')
      assert(have.includes(idx), `missing index ${idx} after v156 (have: ${have.join(',')})`)
    }
    for (const idx of ['task_conversations_lookup', 'task_conversations_pending']) {
      const have = indexNames(raw, 'task_conversations')
      assert(have.includes(idx), `missing index ${idx} after v156 (have: ${have.join(',')})`)
    }

    seedTask(raw, 't1')
    insSession(raw).run(
      's-full', M, '/w', 't1', 'c1', 'slay-spawned-resume', 'dead',
      '{"usedResume":true,"spawnedAt":5}', 100, 110, 'tab-1', 120
    )
    insSession(raw).run('s-pooled', M, null, null, null, 'pending-spawn', 'pooled', null, 200, null, null, null)
    insConv(raw).run('tc-full', 't1', M, 'c1', 'foreign-observed', '{"a":1}', 300)
    insConv(raw).run('tc-null', 't1', M, null, 'manual-reset', null, 400)
    const before = {
      sessions: raw.prepare(`SELECT * FROM agent_sessions ORDER BY id`).all(),
      convs: raw.prepare(`SELECT * FROM task_conversations ORDER BY id`).all()
    }
    // Re-run v156's rebuild against populated tables — the data-copy path a live
    // store takes on upgrade. Run that migration's `up` directly rather than
    // rewinding `user_version`: a rewind re-runs every LATER migration too, and
    // those are not idempotent by design (a plain `ALTER TABLE … ADD COLUMN`
    // throws on a second pass, and SQLite has no `ADD COLUMN IF NOT EXISTS`).
    replayMigration(raw, 156)
    assert(
      JSON.stringify(raw.prepare(`SELECT * FROM agent_sessions ORDER BY id`).all()) ===
        JSON.stringify(before.sessions),
      'agent_sessions rows changed across the v156 rebuild'
    )
    assert(
      JSON.stringify(raw.prepare(`SELECT * FROM task_conversations ORDER BY id`).all()) ===
        JSON.stringify(before.convs),
      'task_conversations rows changed across the v156 rebuild'
    )
    assert(
      indexNames(raw, 'agent_sessions').includes('agent_sessions_tab'),
      'agent_sessions_tab must survive a replayed rebuild'
    )
    raw.close()
  }

  // ── v157: the session_deletions tombstone table ───────────────────────────
  {
    const raw = migratedDb()
    assert(
      indexNames(raw, 'session_deletions').includes('session_deletions_lookup'),
      'session_deletions_lookup index must exist'
    )
    assert(
      columnNames(raw, 'session_deletions').join(',') ===
        'id,task_id,mode,conversation_id,created_at',
      `session_deletions columns: ${columnNames(raw, 'session_deletions').join(',')}`
    )
    seedTask(raw, 't1')
    raw
      .prepare(
        `INSERT INTO session_deletions (id, task_id, mode, conversation_id, created_at)
         VALUES ('d1', 't1', ?, 'c1', 1)`
      )
      .run(M)
    raw.prepare(`DELETE FROM tasks WHERE id = 't1'`).run()
    const n = (raw.prepare(`SELECT count(*) AS n FROM session_deletions`).get() as { n: number }).n
    assert(n === 0, `session_deletions must cascade-delete with its task, ${n} left`)
    raw.close()
  }

  // ── Switch: a user-selected row makes an OLDER session current again ──────
  {
    const raw = migratedDb()
    seedTask(raw, 't1')
    const db = bridge(raw)
    await recordConversation(db, { taskId: 't1', mode: M, conversationId: 'A', origin: 'slay-spawned-fresh' })
    await new Promise((r) => setTimeout(r, 2))
    await recordConversation(db, { taskId: 't1', mode: M, conversationId: 'B', origin: 'slay-spawned-fresh' })
    assert((await getCurrentConversationId(db, 't1', M)) === 'B', 'newest session should start current')

    assert(await isHonoredConversation(db, 't1', M, 'A'), 'A must be switchable')
    assert(!(await isHonoredConversation(db, 't1', M, 'nope')), 'unknown id must not be switchable')
    assert(!(await isHonoredConversation(db, 't2', M, 'A')), "another task's id must not be switchable")

    await new Promise((r) => setTimeout(r, 2))
    await recordConversation(db, { taskId: 't1', mode: M, conversationId: 'A', origin: 'user-selected' })
    assert((await getCurrentConversationId(db, 't1', M)) === 'A', 'switch must make A current')

    const sessions = await listTaskSessions(db, 't1', M)
    assert(sessions.length === 2, `switch must not create a new session (got ${sessions.length})`)
    assert(
      sessions.find((s) => s.conversationId === 'A')?.isCurrent === true,
      'A must be flagged current'
    )
    assert(
      sessions.find((s) => s.conversationId === 'A')?.origin === 'slay-spawned-fresh',
      "a switch must not rewrite the session's recorded provenance"
    )
    // The legacy mirror consumers still read must follow the switch.
    const t = raw.prepare(`SELECT claude_conversation_id AS c FROM tasks WHERE id = 't1'`).get() as {
      c: string
    }
    assert(t.c === 'A', `legacy column must mirror the switch, got ${t.c}`)

    // A switch after a reset cutoff still works (the new row is past the cutoff).
    await recordConversation(db, { taskId: 't1', mode: M, conversationId: null, origin: 'manual-reset' })
    assert((await getCurrentConversationId(db, 't1', M)) === null, 'reset must clear current')
    await new Promise((r) => setTimeout(r, 2))
    await recordConversation(db, { taskId: 't1', mode: M, conversationId: 'B', origin: 'user-selected' })
    assert(
      (await getCurrentConversationId(db, 't1', M)) === 'B',
      'switch must work after a reset cutoff'
    )
    raw.close()
  }

  // ── Delete: tombstone hides the session everywhere, current is protected ──
  {
    const raw = migratedDb()
    seedTask(raw, 't1')
    const db = bridge(raw)
    await recordConversation(db, { taskId: 't1', mode: M, conversationId: 'A', origin: 'slay-spawned-fresh' })
    await new Promise((r) => setTimeout(r, 2))
    await recordConversation(db, { taskId: 't1', mode: M, conversationId: 'B', origin: 'slay-spawned-fresh' })
    insPrompt(raw).run('p-a', 't1', M, 'A', 'hello from A', 1)
    insPrompt(raw).run('p-b', 't1', M, 'B', 'hello from B', 2)

    // The current session is NOT deletable — the live agent is running on it.
    assert(!(await deleteSession(db, 't1', M, 'B')), 'deleting the CURRENT session must be refused')
    assert((await listTaskSessions(db, 't1', M)).length === 2, 'refused delete must not tombstone')

    assert(await deleteSession(db, 't1', M, 'A'), 'deleting a non-current session must succeed')
    const after = await listTaskSessions(db, 't1', M)
    assert(after.length === 1 && after[0]?.conversationId === 'B', 'A must be gone from the list')
    assert(!(await isHonoredConversation(db, 't1', M, 'A')), 'a deleted session must not be switchable')
    // (the Messages-sidebar side of the tombstone — listPromptsForTask — is
    // asserted in agent-turns/src/server/prompt-capture.test.ts, which owns that op)

    // Deleting is scoped: the same conversation id under another mode survives.
    await recordConversation(db, { taskId: 't1', mode: 'codex', conversationId: 'A', origin: 'slay-spawned-fresh' })
    assert(
      (await getCurrentConversationId(db, 't1', 'codex')) === 'A',
      'a tombstone must not leak across modes'
    )

    // Defence in depth: even if a later honored row named a deleted conversation,
    // it must never become the resume target.
    await new Promise((r) => setTimeout(r, 2))
    await recordConversation(db, { taskId: 't1', mode: M, conversationId: 'A', origin: 'in-band-clear' })
    assert(
      (await getCurrentConversationId(db, 't1', M)) === 'B',
      'a deleted conversation must never resolve as current'
    )
    raw.close()
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('OK — session switch/delete (v156 + v157) checks passed')
}

void main()
