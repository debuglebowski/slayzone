/**
 * v147 first-class agent-session migration tests.
 * Backfills the v145 `task_conversations` ledger into the new `agent_sessions`
 * + `session_resets` tables, preserving id + created_at so the new resolver
 * picks the exact same "current" conversation. See plans/agent-sessions.md.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm packages/apps/app/src/main/db/v147-agent-sessions-migration.test.ts
 */
import Database from 'better-sqlite3'
import { migrations } from '@slayzone/transport/db-bootstrap'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (error) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${error instanceof Error ? error.message : String(error)}`)
    failed++
  }
}

function expectEqual(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Expected ${e}, got ${a}`)
}

/** Build a DB migrated to exactly v146 (pre-v147 schema — has v145 ledger). */
function dbAtV146(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  for (const m of migrations) {
    if (m.version > 146) break
    db.transaction(() => {
      m.up(db)
      db.pragma(`user_version = ${m.version}`)
    })()
  }
  return db
}

function applyV147(db: Database.Database): void {
  const v147 = migrations.find((m) => m.version === 147)
  if (!v147) throw new Error('v147 migration not found')
  db.transaction(() => {
    v147.up(db)
    db.pragma('user_version = 147')
  })()
}

function seedTask(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, priority) VALUES (?, 'p1', ?, 'todo', 3)`
  ).run(id, `Task ${id}`)
}

function seedConv(
  db: Database.Database,
  args: {
    id: string
    taskId: string
    mode: string
    conversationId: string | null
    origin: string
    pendingMeta?: string | null
    createdAt: number
  }
): void {
  db.prepare(
    `INSERT INTO task_conversations
       (id, task_id, mode, conversation_id, origin, pending_meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    args.id,
    args.taskId,
    args.mode,
    args.conversationId,
    args.origin,
    args.pendingMeta ?? null,
    args.createdAt
  )
}

/** The new resolver (session_resets cutoff), run inline against the migrated DB. */
function currentConv(db: Database.Database, taskId: string, mode: string): string | null {
  const row = db
    .prepare(
      `WITH reset AS (
         SELECT max(created_at) AS at FROM session_resets WHERE task_id = ? AND mode = ?
       )
       SELECT conversation_id FROM agent_sessions
        WHERE task_id = ? AND mode = ?
          AND conversation_id IS NOT NULL
          AND origin IN ('slay-spawned-fresh','slay-spawned-resume','cas-repoint-heal','legacy-migration')
          AND created_at > coalesce((SELECT at FROM reset), 0)
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(taskId, mode, taskId, mode) as { conversation_id: string | null } | undefined
  return row?.conversation_id ?? null
}

console.log('\nv147 first-class agent-session migration')

test('backfills sessions + reset, preserves id/created_at, drops the manual-reset session', () => {
  const db = dbAtV146()
  try {
    db.prepare("INSERT INTO projects (id, name, color, path) VALUES ('p1','P','#000','/tmp/p')").run()
    seedTask(db, 't1')
    // Honored, foreign, reset, fresh-after-reset, pending — a full timeline.
    seedConv(db, { id: 'r1', taskId: 't1', mode: 'claude-code', conversationId: 'C1', origin: 'slay-spawned-fresh', createdAt: 1000 })
    seedConv(db, { id: 'r2', taskId: 't1', mode: 'claude-code', conversationId: 'C2', origin: 'slay-spawned-resume', createdAt: 1001 })
    seedConv(db, { id: 'r3', taskId: 't1', mode: 'claude-code', conversationId: 'F1', origin: 'foreign-observed', createdAt: 1002 })
    seedConv(db, { id: 'r4', taskId: 't1', mode: 'claude-code', conversationId: null, origin: 'manual-reset', createdAt: 1003 })
    seedConv(db, { id: 'r5', taskId: 't1', mode: 'claude-code', conversationId: 'C3', origin: 'slay-spawned-fresh', createdAt: 1004 })
    seedConv(db, { id: 'r6', taskId: 't1', mode: 'claude-code', conversationId: 'P1', origin: 'pending-spawn', pendingMeta: '{"usedResume":false,"spawnedAt":1005}', createdAt: 1005 })

    applyV147(db)

    // 5 sessions (every origin except manual-reset), 1 reset event.
    const sessCount = (db.prepare("SELECT count(*) AS n FROM agent_sessions WHERE task_id='t1' AND mode='claude-code'").get() as { n: number }).n
    expectEqual(sessCount, 5)
    const resetCount = (db.prepare("SELECT count(*) AS n FROM session_resets WHERE task_id='t1' AND mode='claude-code'").get() as { n: number }).n
    expectEqual(resetCount, 1)
    const resetInSessions = (db.prepare("SELECT count(*) AS n FROM agent_sessions WHERE origin='manual-reset'").get() as { n: number }).n
    expectEqual(resetInSessions, 0)

    // id + created_at preserved; backfilled rows are dead/audit (cwd NULL, status dead, bound_at=created_at).
    const c1 = db.prepare("SELECT id, conversation_id, origin, status, cwd, created_at, bound_at FROM agent_sessions WHERE id='r1'").get() as Record<string, unknown>
    expectEqual(c1, { id: 'r1', conversation_id: 'C1', origin: 'slay-spawned-fresh', status: 'dead', cwd: null, created_at: 1000, bound_at: 1000 })

    // reset event preserved id + created_at.
    const reset = db.prepare("SELECT id, task_id, mode, created_at FROM session_resets WHERE id='r4'").get() as Record<string, unknown>
    expectEqual(reset, { id: 'r4', task_id: 't1', mode: 'claude-code', created_at: 1003 })

    // New resolver picks C3 — honored, strictly after the reset cutoff.
    expectEqual(currentConv(db, 't1', 'claude-code'), 'C3')
  } finally {
    db.close()
  }
})

test('empty ledger → empty agent tables, resolver returns null', () => {
  const db = dbAtV146()
  try {
    db.prepare("INSERT INTO projects (id, name, color, path) VALUES ('p1','P','#000','/tmp/p')").run()
    seedTask(db, 't1')

    applyV147(db)

    expectEqual((db.prepare('SELECT count(*) AS n FROM agent_sessions').get() as { n: number }).n, 0)
    expectEqual((db.prepare('SELECT count(*) AS n FROM session_resets').get() as { n: number }).n, 0)
    expectEqual(currentConv(db, 't1', 'claude-code'), null)
  } finally {
    db.close()
  }
})

test('foreign-observed alone after reset → resolver null (not honored)', () => {
  const db = dbAtV146()
  try {
    db.prepare("INSERT INTO projects (id, name, color, path) VALUES ('p1','P','#000','/tmp/p')").run()
    seedTask(db, 't1')
    seedConv(db, { id: 'r1', taskId: 't1', mode: 'codex', conversationId: 'X1', origin: 'slay-spawned-fresh', createdAt: 1000 })
    seedConv(db, { id: 'r2', taskId: 't1', mode: 'codex', conversationId: null, origin: 'manual-reset', createdAt: 1001 })
    seedConv(db, { id: 'r3', taskId: 't1', mode: 'codex', conversationId: 'Y1', origin: 'foreign-observed', createdAt: 1002 })

    applyV147(db)

    // Only a foreign row exists after the reset — never honored → null (matches v145 semantics).
    expectEqual(currentConv(db, 't1', 'codex'), null)
  } finally {
    db.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
