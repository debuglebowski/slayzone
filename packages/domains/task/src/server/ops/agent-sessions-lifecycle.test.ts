import { describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  recordSessionSpawn,
  confirmSessionConversation,
  confirmSessionConversationByTaskMode,
  markSessionDead,
  markSessionFirstTurn,
  bindSessionToTask,
  findPendingSpawn,
  getCurrentConversationId
} from './agent-sessions.js'

// Harness — agent_sessions (v147 + v148 columns) + session_resets.
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
    ended_at        INTEGER,
    CHECK (origin IN (
      'slay-spawned-fresh','slay-spawned-resume','cas-repoint-heal',
      'legacy-migration','foreign-observed','pending-spawn'
    )),
    CHECK (status IN ('pooled','bound','dead'))
  );
  CREATE TABLE session_resets (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, mode TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE session_turns (
    conversation_id TEXT PRIMARY KEY, first_turn_at INTEGER NOT NULL
  );
  CREATE TABLE session_deletions (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, mode TEXT NOT NULL,
    conversation_id TEXT NOT NULL, created_at INTEGER NOT NULL
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Steps share one in-memory DB and run in declaration order; each test builds
// on the state the previous ones left behind.
describe('agent_sessions B-lifecycle', () => {
  // 1. Pre-mint fresh (claude): spawn with expected==observed → fresh, honored.
  let p1: Awaited<ReturnType<typeof findPendingSpawn>>
  test('pending session found by task+mode, exposes runtime key', async () => {
    await recordSessionSpawn(db, {
      id: 'S1',
      taskId: 't1',
      tabId: 't1',
      mode: 'claude-code',
      cwd: '/p',
      expectedConversationId: 'S1',
      usedResume: false,
      status: 'bound'
    })
    p1 = await findPendingSpawn(db, 't1', 'claude-code')
    expect(p1?.sessionId).toBe('S1')
  })

  test('expected id preserved', () => {
    expect(p1?.expectedSessionId).toBe('S1')
  })

  test('pending not honored yet', async () => {
    expect(await getCurrentConversationId(db, 't1', 'claude-code')).toBeNull()
  })

  test('match+no-resume → fresh', async () => {
    const o1 = await confirmSessionConversation(db, {
      sessionId: 'S1',
      observedConversationId: 'S1'
    })
    expect(o1).toBe('slay-spawned-fresh')
  })

  // 1b. A confirmed FRESH spawn is not yet resumable (v158): claude writes its
  //     transcript at the first turn, so until then `--resume S1` would fail with
  //     "No conversation found with session ID:". Confirming only proves the
  //     process started, which is the exact thing that used to be mistaken for
  //     proof — and what let a never-used warm agent become a task's resume
  //     target for 77 minutes.
  test('confirmed-but-turnless fresh spawn must not be a resume target yet', async () => {
    expect(await getCurrentConversationId(db, 't1', 'claude-code')).toBeNull()
  })

  test('fresh becomes current after its first turn', async () => {
    await markSessionFirstTurn(db, 'S1')
    expect(await getCurrentConversationId(db, 't1', 'claude-code')).toBe('S1')
  })

  // 2. Write-once: a second confirm is a no-op (origin no longer pending).
  test('second confirm is a no-op (write-once)', async () => {
    const o1b = await confirmSessionConversation(db, {
      sessionId: 'S1',
      observedConversationId: 'HIJACK'
    })
    expect(o1b).toBeNull()
  })

  test('conversation_id unchanged after re-confirm', async () => {
    expect(await getCurrentConversationId(db, 't1', 'claude-code')).toBe('S1')
  })

  // 3. Resume: expected==observed + usedResume → resume.
  test('match+resume → resume', async () => {
    await sleep(2)
    await recordSessionSpawn(db, {
      id: 'S2',
      taskId: 't1',
      tabId: 't1',
      mode: 'claude-code',
      cwd: '/p',
      expectedConversationId: 'S1',
      usedResume: true,
      status: 'bound'
    })
    const o2 = await confirmSessionConversation(db, {
      sessionId: 'S2',
      observedConversationId: 'S1'
    })
    expect(o2).toBe('slay-spawned-resume')
  })

  // 4. Foreign: observed != expected → foreign-observed, NOT honored.
  test('mismatch → foreign', async () => {
    await sleep(2)
    await recordSessionSpawn(db, {
      id: 'S3',
      taskId: 't1',
      tabId: 't1',
      mode: 'claude-code',
      cwd: '/p',
      expectedConversationId: 'S1',
      usedResume: true,
      status: 'bound'
    })
    const o3 = await confirmSessionConversation(db, {
      sessionId: 'S3',
      observedConversationId: 'FOREIGN'
    })
    expect(o3).toBe('foreign-observed')
  })

  test('foreign not honored — last honored (S1) wins', async () => {
    expect(await getCurrentConversationId(db, 't1', 'claude-code')).toBe('S1')
  })

  // 5. Null-expected (codex/gemini mint own): accept first observation as fresh.
  let oc: Awaited<ReturnType<typeof confirmSessionConversationByTaskMode>>
  test('null-expected → fresh', async () => {
    await recordSessionSpawn(db, {
      id: 'C1',
      taskId: 't1',
      tabId: 't1',
      mode: 'codex',
      cwd: '/p',
      expectedConversationId: null,
      usedResume: false,
      status: 'bound'
    })
    oc = await confirmSessionConversationByTaskMode(db, {
      taskId: 't1',
      mode: 'codex',
      observedConversationId: 'CDX-9'
    })
    expect(oc?.origin).toBe('slay-spawned-fresh')
  })

  test('hook-path confirm returns runtime key', () => {
    expect(oc?.sessionId).toBe('C1')
  })

  test('codex conversation honored', async () => {
    expect(await getCurrentConversationId(db, 't1', 'codex')).toBe('CDX-9')
  })

  // 6. markSessionDead → no longer an in-flight pending; honored conversation stays.
  test('gemini pending in-flight', async () => {
    await recordSessionSpawn(db, {
      id: 'S4',
      taskId: 't1',
      tabId: 't1',
      mode: 'gemini',
      cwd: '/p',
      expectedConversationId: null,
      usedResume: false,
      status: 'bound'
    })
    expect(await findPendingSpawn(db, 't1', 'gemini')).not.toBeNull()
  })

  test('dead session not returned as in-flight pending', async () => {
    await markSessionDead(db, 'S4')
    expect(await findPendingSpawn(db, 't1', 'gemini')).toBeNull()
  })

  test('markSessionDead sets status + ended_at', () => {
    const s4 = raw.prepare("SELECT status, ended_at FROM agent_sessions WHERE id='S4'").get() as {
      status: string
      ended_at: number | null
    }
    expect(s4.status).toBe('dead')
    expect(typeof s4.ended_at).toBe('number')
  })

  // 7. Reset cutoff hides earlier honored conversations.
  test('reset hides S1', async () => {
    raw
      .prepare(
        "INSERT INTO session_resets (id, task_id, mode, created_at) VALUES ('r1','t1','claude-code',?)"
      )
      .run(Date.now())
    expect(await getCurrentConversationId(db, 't1', 'claude-code')).toBeNull()
  })

  // 8. Pool lifecycle: spawn pooled (no task) → confirm → bind to task → honored.
  test('pooled session not bound to any task', async () => {
    await recordSessionSpawn(db, {
      id: 'POOL1',
      taskId: null,
      tabId: null,
      mode: 'claude-code',
      cwd: '/p',
      expectedConversationId: 'POOL1',
      usedResume: false,
      status: 'pooled'
    })
    await confirmSessionConversation(db, { sessionId: 'POOL1', observedConversationId: 'POOL1' })
    expect(await getCurrentConversationId(db, 't2', 'claude-code')).toBeNull()
  })

  test('pooled session binds to task', async () => {
    const bound = await bindSessionToTask(db, { sessionId: 'POOL1', taskId: 't2', tabId: 't2' })
    expect(bound).toBe(true)
  })

  // Binding transfers OWNERSHIP, not resumability. A warm agent is pre-booted and
  // can idle turn-less for hours; adopting it must not make its empty id the
  // task's resume target, because `--resume POOL1` would fail and the recovery
  // path used to answer that by RESETTING the task — cutting off the conversation
  // that was actually doing the work. This is the a426d99d incident in one line.
  test('a bound but turnless pool session must not be honored as a resume target', async () => {
    expect(await getCurrentConversationId(db, 't2', 'claude-code')).toBeNull()
  })

  test('bound pool session is honored for its task once it has taken a turn', async () => {
    await markSessionFirstTurn(db, 'POOL1')
    expect(await getCurrentConversationId(db, 't2', 'claude-code')).toBe('POOL1')
  })

  // 9. bind is set-once — a second bind is a no-op.
  test('second bind no-op (set-once, no reattach)', async () => {
    const bound2 = await bindSessionToTask(db, { sessionId: 'POOL1', taskId: 't3', tabId: 't3' })
    expect(bound2).toBe(false)
  })

  test('session did not move to t3', async () => {
    expect(await getCurrentConversationId(db, 't3', 'claude-code')).toBeNull()
  })
})
