import Database from 'better-sqlite3'
import type { SlayzoneDb } from '@slayzone/platform'
import { listTaskSessions } from './agent-sessions.js'

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

// Harness — agent_sessions + session_resets + agent_prompts (columns used by
// listTaskSessions: session grouping, reset cutoff, per-session message count).
const raw = new Database(':memory:')
raw.exec(`
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
    ended_at        INTEGER
  );
  CREATE TABLE session_resets (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, mode TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE agent_prompts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    cli_session_id TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL
  );
`)

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
  }
} as unknown as SlayzoneDb

// Insert an agent_sessions row directly (raw, avoids exercising the write path).
function insSession(o: {
  id: string
  taskId: string | null
  mode: string
  conv: string | null
  origin: string
  status?: string
  createdAt: number
}): void {
  raw
    .prepare(
      `INSERT INTO agent_sessions (id, mode, cwd, task_id, conversation_id, origin, status, created_at)
       VALUES (?, ?, '/p', ?, ?, ?, ?, ?)`
    )
    .run(o.id, o.mode, o.taskId, o.conv, o.origin, o.status ?? 'dead', o.createdAt)
}

function insPrompt(o: { id: string; taskId: string; mode: string; conv: string | null; text: string; createdAt: number }): void {
  raw
    .prepare(
      `INSERT INTO agent_prompts (id, task_id, agent_id, cli_session_id, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(o.id, o.taskId, o.mode, o.conv, o.text, o.createdAt)
}

async function main(): Promise<void> {
  const T = 't1'
  const M = 'claude-code'
  let clk = 1000

  // Session A: a pending-spawn shadow (pre-minted expected id 'A') PRECEDES the
  // confirmed fresh row for the same conversation — the triple-write path. Then
  // two resume re-spawns → SAME conversation_id 'A'. Must collapse to ONE entry
  // whose origin is the confirmed 'fresh' (NOT the earlier pending shadow), and
  // NOT be dropped for having a pending row (live-data invariant: 20 rows / 1
  // conversation).
  insSession({ id: 'a0', taskId: T, mode: M, conv: 'A', origin: 'pending-spawn', createdAt: 999 }) // shadow, earliest
  insSession({ id: 'a1', taskId: T, mode: M, conv: 'A', origin: 'slay-spawned-fresh', createdAt: clk++ })
  insSession({ id: 'a2', taskId: T, mode: M, conv: 'A', origin: 'slay-spawned-resume', createdAt: clk++ })
  insSession({ id: 'a3', taskId: T, mode: M, conv: 'A', origin: 'slay-spawned-resume', createdAt: clk++ })
  // Session B: separate fresh conversation.
  insSession({ id: 'b1', taskId: T, mode: M, conv: 'B', origin: 'slay-spawned-fresh', createdAt: clk++ })
  // Noise that must be EXCLUDED:
  insSession({ id: 'p1', taskId: T, mode: M, conv: null, origin: 'pending-spawn', createdAt: clk++ }) // null conv
  insSession({ id: 'p2', taskId: T, mode: M, conv: 'PHANTOM', origin: 'pending-spawn', createdAt: clk++ }) // pending w/ pre-minted id, died pre-confirm
  insSession({ id: 'f1', taskId: T, mode: M, conv: 'FGN', origin: 'foreign-observed', createdAt: clk++ }) // manual --resume, audit-only
  insSession({ id: 'o1', taskId: 'OTHER', mode: M, conv: 'X', origin: 'slay-spawned-fresh', createdAt: clk++ }) // other task
  insSession({ id: 'w1', taskId: null, mode: M, conv: 'W', origin: 'slay-spawned-fresh', createdAt: clk++ }) // warm pool
  insSession({ id: 'm1', taskId: T, mode: 'codex', conv: 'CDX', origin: 'slay-spawned-fresh', createdAt: clk++ }) // other mode

  // Prompts: 3 in session A, 1 in session B. First prompt of A = "hello A".
  insPrompt({ id: 'pa1', taskId: T, mode: M, conv: 'A', text: 'hello A', createdAt: 1001 })
  insPrompt({ id: 'pa2', taskId: T, mode: M, conv: 'A', text: 'second A', createdAt: 1002 })
  insPrompt({ id: 'pa3', taskId: T, mode: M, conv: 'A', text: 'third A', createdAt: 1003 })
  insPrompt({ id: 'pb1', taskId: T, mode: M, conv: 'B', text: 'hello B', createdAt: 1010 })

  const sessions = await listTaskSessions(db, T, M)

  // 1. Exactly two sessions (A + B), resume re-spawns collapsed, noise excluded.
  assert(sessions.length === 2, `expected 2 sessions, got ${sessions.length}`)

  // 2. Newest-first ordering: B started after A.
  assert(sessions[0].conversationId === 'B', `newest first: expected B, got ${sessions[0].conversationId}`)
  assert(sessions[1].conversationId === 'A', `oldest last: expected A, got ${sessions[1].conversationId}`)

  const a = sessions.find((s) => s.conversationId === 'A')!
  const b = sessions.find((s) => s.conversationId === 'B')!

  // 3. Message counts join on cli_session_id == conversation_id.
  assert(a.messageCount === 3, `A messageCount expected 3, got ${a.messageCount}`)
  assert(b.messageCount === 1, `B messageCount expected 1, got ${b.messageCount}`)

  // 4. First-prompt preview = earliest prompt text.
  assert(a.firstPrompt === 'hello A', `A firstPrompt expected 'hello A', got ${a.firstPrompt}`)
  assert(b.firstPrompt === 'hello B', `B firstPrompt expected 'hello B', got ${b.firstPrompt}`)

  // 5. startedAt = earliest spawn of the group (A's first row).
  assert(a.startedAt === 1000, `A startedAt expected 1000, got ${a.startedAt}`)
  assert(a.lastActiveAt === 1002, `A lastActiveAt expected 1002 (last resume), got ${a.lastActiveAt}`)

  // 5b. origin = the FIRST spawn's origin (fresh), NOT a later resume row.
  assert(a.origin === 'slay-spawned-fresh', `A origin expected fresh (first spawn), got ${a.origin}`)

  // 6. isCurrent: B is the latest honored (no reset yet).
  assert(b.isCurrent === true, 'B is current')
  assert(a.isCurrent === false, 'A is not current')

  // 7. Reset cutoff: reset after B → nothing honored → no session is current.
  raw.prepare(`INSERT INTO session_resets (id, task_id, mode, created_at) VALUES ('r1', ?, ?, ?)`).run(T, M, clk++)
  const afterReset = await listTaskSessions(db, T, M)
  assert(afterReset.every((s) => s.isCurrent === false), 'after reset, no session is current')
  // History still lists both sessions (reset is a cutoff for "current", not deletion).
  assert(afterReset.length === 2, `after reset still 2 sessions, got ${afterReset.length}`)

  console.log('OK — listTaskSessions checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
