/**
 * One task per provider session (investigation #4, follow-up to #172).
 *
 * Pre-ledger builds wrote one Claude session id into the provider_config of TWO
 * tasks (the SessionStart hook honored whatever `/resume` picked in a shared
 * cwd), and the v-ledger backfill turned both into honored `legacy-migration`
 * claims. Both tasks then resumed one transcript, and once one of them bound it
 * to a chat owner the other was fenced forever.
 *
 * The rule under test: a provider session is the task's that claimed it FIRST
 * (honored, not deleted; across every mode). Every other task's claim is
 * invisible to every reader that answers "which sessions does this task have /
 * resume?" — so the losing task starts fresh and never shows the winner's
 * history. A relinquished claim (tombstone) no longer contests.
 *
 * Full production migration chain on a real better-sqlite3 handle.
 */
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { DB_PRAGMAS, type BatchOp, type SlayzoneDb } from '@slayzone/platform'
import { runMigrations } from '@slayzone/db-migrations'
import {
  claimedByOtherTasks,
  getCurrentConversationId,
  isHonoredConversation,
  listResumeCandidates,
  listSharedSessionClaims,
  listTaskSessions,
  OWNED_AT_SQL,
  relinquishSession,
  resumableSessionSql
} from './agent-sessions.js'

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
    }
  } as unknown as SlayzoneDb
}

const M = 'claude-code'

function setup() {
  const raw = new Database(':memory:')
  for (const pragma of DB_PRAGMAS) raw.pragma(pragma)
  runMigrations(raw)
  raw.prepare(`INSERT INTO projects (id, name, color) VALUES ('p1', 'P', '#000')`).run()
  for (const id of ['task-a', 'task-b', 'task-c'])
    raw.prepare(`INSERT INTO tasks (id, project_id, title) VALUES (?, 'p1', ?)`).run(id, id)
  let n = 0
  /** An honored, proven claim of `conversationId` by `taskId`, owned at `at`. */
  const claim = (
    taskId: string,
    conversationId: string,
    at: number,
    origin = 'legacy-migration',
    mode = M
  ) => {
    raw
      .prepare(
        `INSERT INTO agent_sessions (id, mode, task_id, conversation_id, origin, status, created_at, bound_at)
         VALUES (?, ?, ?, ?, ?, 'dead', ?, ?)`
      )
      .run(`s${++n}`, mode, taskId, conversationId, origin, at, at)
    raw
      .prepare(`INSERT OR IGNORE INTO session_turns (conversation_id, first_turn_at) VALUES (?, ?)`)
      .run(conversationId, at)
  }
  return { raw, db: bridge(raw), claim }
}

describe('a provider session shared by two tasks belongs to the earliest claimant', () => {
  test('the later claimant does not resume it, list it, or honor it', async () => {
    const { db, claim } = setup()
    claim('task-a', 'shared', 1)
    claim('task-b', 'shared', 2)

    expect(await getCurrentConversationId(db, 'task-a', M)).toBe('shared')
    expect(await getCurrentConversationId(db, 'task-b', M)).toBeNull()
    expect(await isHonoredConversation(db, 'task-a', M, 'shared')).toBe(true)
    expect(await isHonoredConversation(db, 'task-b', M, 'shared')).toBe(false)
    expect(await listResumeCandidates(db, 'task-b', M)).toEqual([])
    expect((await listTaskSessions(db, 'task-b', M)).map((s) => s.conversationId)).toEqual([])
    expect((await listTaskSessions(db, 'task-a', M)).map((s) => s.conversationId)).toEqual([
      'shared'
    ])
  })

  test('the loser falls back to its own newest session, never the winner', async () => {
    const { db, claim } = setup()
    claim('task-b', 'own-b', 1, 'slay-spawned-fresh')
    claim('task-a', 'shared', 2)
    claim('task-b', 'shared', 3)
    expect(await getCurrentConversationId(db, 'task-b', M)).toBe('own-b')
  })

  test("the winner is decided by each task's FIRST claim, not its newest row", async () => {
    const { db, claim } = setup()
    claim('task-a', 'shared', 1)
    claim('task-b', 'shared', 2)
    // A later resume in A must not hand the session to B (whose first claim is earlier
    // than A's newest row).
    claim('task-a', 'shared', 5, 'slay-spawned-resume')
    expect(await getCurrentConversationId(db, 'task-a', M)).toBe('shared')
    expect(await getCurrentConversationId(db, 'task-b', M)).toBeNull()
  })

  test('a tie on claim time is broken by task id, deterministically', async () => {
    const { db, claim } = setup()
    claim('task-b', 'shared', 7)
    claim('task-a', 'shared', 7)
    expect(await getCurrentConversationId(db, 'task-a', M)).toBe('shared')
    expect(await getCurrentConversationId(db, 'task-b', M)).toBeNull()
  })

  test('a claim under another mode contests too (chat and terminal share session files)', async () => {
    const { db, claim } = setup()
    claim('task-a', 'shared', 1, 'legacy-migration', 'claude-chat')
    claim('task-b', 'shared', 2)
    expect(await getCurrentConversationId(db, 'task-b', M)).toBeNull()
  })

  test('one task holding the session under two modes is not a conflict', async () => {
    const { db, claim } = setup()
    claim('task-a', 'shared', 1, 'legacy-migration', 'claude-chat')
    claim('task-a', 'shared', 2, 'handoff')
    expect(await getCurrentConversationId(db, 'task-a', M)).toBe('shared')
    expect(await getCurrentConversationId(db, 'task-a', 'claude-chat')).toBe('shared')
    expect(await listSharedSessionClaims(db)).toEqual([])
  })

  test('a foreign-observed (audit-only) row never contests', async () => {
    const { db, claim } = setup()
    claim('task-a', 'shared', 1, 'foreign-observed')
    claim('task-b', 'shared', 2)
    expect(await getCurrentConversationId(db, 'task-b', M)).toBe('shared')
  })

  test('a relinquished claim no longer contests: the other task gets it', async () => {
    const { db, claim } = setup()
    claim('task-a', 'shared', 1)
    claim('task-b', 'shared', 2)
    // Relinquishing ignores the "current" guard deleteSession has: it is exactly the
    // current session that must go.
    await relinquishSession(db, 'task-a', M, 'shared')
    expect(await getCurrentConversationId(db, 'task-a', M)).toBeNull()
    expect(await getCurrentConversationId(db, 'task-b', M)).toBe('shared')
  })

  test('the batched resume hint (shared.ts predicate) agrees with the single-task resolver', async () => {
    const { db, claim } = setup()
    claim('task-a', 'shared', 1)
    claim('task-b', 'shared', 2)
    // Same shape as attachCurrentConversationByMode: a reset JOIN, not a subquery.
    const rows = await db.all<{ task_id: string; conversation_id: string }>(
      `WITH reset AS (SELECT task_id, mode, max(created_at) AS at FROM session_resets GROUP BY task_id, mode),
       ranked AS (
         SELECT s.task_id, s.conversation_id,
                ROW_NUMBER() OVER (PARTITION BY s.task_id, s.mode ORDER BY ${OWNED_AT_SQL} DESC) AS rn
           FROM agent_sessions s
           LEFT JOIN reset r ON r.task_id = s.task_id AND r.mode = s.mode
          WHERE s.task_id IN ('task-a','task-b') AND ${resumableSessionSql('r.at')}
       )
       SELECT task_id, conversation_id FROM ranked WHERE rn = 1 ORDER BY task_id`
    )
    expect(rows).toEqual([{ task_id: 'task-a', conversation_id: 'shared' }])
  })
})

describe('claimedByOtherTasks (healer history filter)', () => {
  test('names ids another task wins, keeps own and unclaimed ids', async () => {
    const { db, claim } = setup()
    claim('task-a', 'a-wins', 1)
    claim('task-b', 'a-wins', 2)
    claim('task-b', 'b-wins', 1)
    claim('task-a', 'b-wins', 2)
    claim('task-a', 'only-b', 1, 'foreign-observed')
    claim('task-b', 'only-b', 2)
    expect([
      ...(await claimedByOtherTasks(db, 'task-b', ['a-wins', 'b-wins', 'only-b', 'unknown']))
    ]).toEqual(['a-wins'])
  })

  test('an id this task never claimed but another task holds is foreign', async () => {
    // provider_config.conversationHistory (pre-ledger) lists ids the ledger never
    // recorded for this task — e.g. a parent's session `/resume`d in a subtask.
    const { db, claim } = setup()
    claim('task-a', 'parents', 1)
    expect([...(await claimedByOtherTasks(db, 'task-b', ['parents']))]).toEqual(['parents'])
  })
})

describe('listSharedSessionClaims (repair input)', () => {
  test('lists every task holding a shared session, earliest claim first', async () => {
    const { db, claim } = setup()
    claim('task-b', 'shared', 2)
    claim('task-a', 'shared', 1)
    claim('task-a', 'shared', 4, 'slay-spawned-resume')
    claim('task-c', 'shared', 3, 'legacy-migration', 'claude-chat')
    claim('task-a', 'solo', 1)
    expect(await listSharedSessionClaims(db)).toEqual([
      {
        conversationId: 'shared',
        claims: [
          { taskId: 'task-a', mode: M, firstClaimAt: 1 },
          { taskId: 'task-b', mode: M, firstClaimAt: 2 },
          { taskId: 'task-c', mode: 'claude-chat', firstClaimAt: 3 }
        ]
      }
    ])
  })

  test('a relinquished claim is not listed', async () => {
    const { db, claim } = setup()
    claim('task-a', 'shared', 1)
    claim('task-b', 'shared', 2)
    await relinquishSession(db, 'task-b', M, 'shared')
    expect(await listSharedSessionClaims(db)).toEqual([])
  })
})
