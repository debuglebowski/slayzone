import Database from 'better-sqlite3'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  recordSessionSpawn,
  confirmSessionConversation,
  confirmSessionConversationByTaskMode,
  markSessionDead,
  bindSessionToTask,
  findPendingSpawn,
  getCurrentConversationId
} from './agent-sessions.js'

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

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

async function main(): Promise<void> {
  // 1. Pre-mint fresh (claude): spawn with expected==observed → fresh, honored.
  await recordSessionSpawn(db, {
    id: 'S1', taskId: 't1', tabId: 't1', mode: 'claude-code', cwd: '/p',
    expectedConversationId: 'S1', usedResume: false, status: 'bound'
  })
  const p1 = await findPendingSpawn(db, 't1', 'claude-code')
  assert(p1?.sessionId === 'S1', 'pending session found by task+mode, exposes runtime key')
  assert(p1?.expectedSessionId === 'S1', 'expected id preserved')
  assert((await getCurrentConversationId(db, 't1', 'claude-code')) === null, 'pending not honored yet')
  const o1 = await confirmSessionConversation(db, { sessionId: 'S1', observedConversationId: 'S1' })
  assert(o1 === 'slay-spawned-fresh', `match+no-resume → fresh, got ${o1}`)
  assert((await getCurrentConversationId(db, 't1', 'claude-code')) === 'S1', 'confirmed fresh is current')

  // 2. Write-once: a second confirm is a no-op (origin no longer pending).
  const o1b = await confirmSessionConversation(db, { sessionId: 'S1', observedConversationId: 'HIJACK' })
  assert(o1b === null, 'second confirm is a no-op (write-once)')
  assert((await getCurrentConversationId(db, 't1', 'claude-code')) === 'S1', 'conversation_id unchanged after re-confirm')

  // 3. Resume: expected==observed + usedResume → resume.
  await sleep(2)
  await recordSessionSpawn(db, {
    id: 'S2', taskId: 't1', tabId: 't1', mode: 'claude-code', cwd: '/p',
    expectedConversationId: 'S1', usedResume: true, status: 'bound'
  })
  const o2 = await confirmSessionConversation(db, { sessionId: 'S2', observedConversationId: 'S1' })
  assert(o2 === 'slay-spawned-resume', `match+resume → resume, got ${o2}`)

  // 4. Foreign: observed != expected → foreign-observed, NOT honored.
  await sleep(2)
  await recordSessionSpawn(db, {
    id: 'S3', taskId: 't1', tabId: 't1', mode: 'claude-code', cwd: '/p',
    expectedConversationId: 'S1', usedResume: true, status: 'bound'
  })
  const o3 = await confirmSessionConversation(db, { sessionId: 'S3', observedConversationId: 'FOREIGN' })
  assert(o3 === 'foreign-observed', `mismatch → foreign, got ${o3}`)
  assert((await getCurrentConversationId(db, 't1', 'claude-code')) === 'S1', 'foreign not honored — last honored (S1) wins')

  // 5. Null-expected (codex/gemini mint own): accept first observation as fresh.
  await recordSessionSpawn(db, {
    id: 'C1', taskId: 't1', tabId: 't1', mode: 'codex', cwd: '/p',
    expectedConversationId: null, usedResume: false, status: 'bound'
  })
  const oc = await confirmSessionConversationByTaskMode(db, { taskId: 't1', mode: 'codex', observedConversationId: 'CDX-9' })
  assert(oc?.origin === 'slay-spawned-fresh', `null-expected → fresh, got ${oc?.origin}`)
  assert(oc?.sessionId === 'C1', 'hook-path confirm returns runtime key')
  assert((await getCurrentConversationId(db, 't1', 'codex')) === 'CDX-9', 'codex conversation honored')

  // 6. markSessionDead → no longer an in-flight pending; honored conversation stays.
  await recordSessionSpawn(db, {
    id: 'S4', taskId: 't1', tabId: 't1', mode: 'gemini', cwd: '/p',
    expectedConversationId: null, usedResume: false, status: 'bound'
  })
  assert((await findPendingSpawn(db, 't1', 'gemini')) !== null, 'gemini pending in-flight')
  await markSessionDead(db, 'S4')
  assert((await findPendingSpawn(db, 't1', 'gemini')) === null, 'dead session not returned as in-flight pending')
  const s4 = raw.prepare("SELECT status, ended_at FROM agent_sessions WHERE id='S4'").get() as { status: string; ended_at: number | null }
  assert(s4.status === 'dead' && typeof s4.ended_at === 'number', 'markSessionDead sets status + ended_at')

  // 7. Reset cutoff hides earlier honored conversations.
  raw.prepare("INSERT INTO session_resets (id, task_id, mode, created_at) VALUES ('r1','t1','claude-code',?)").run(Date.now())
  assert((await getCurrentConversationId(db, 't1', 'claude-code')) === null, 'reset hides S1')

  // 8. Pool lifecycle: spawn pooled (no task) → confirm → bind to task → honored.
  await recordSessionSpawn(db, {
    id: 'POOL1', taskId: null, tabId: null, mode: 'claude-code', cwd: '/p',
    expectedConversationId: 'POOL1', usedResume: false, status: 'pooled'
  })
  await confirmSessionConversation(db, { sessionId: 'POOL1', observedConversationId: 'POOL1' })
  assert((await getCurrentConversationId(db, 't2', 'claude-code')) === null, 'pooled session not bound to any task')
  const bound = await bindSessionToTask(db, { sessionId: 'POOL1', taskId: 't2', tabId: 't2' })
  assert(bound === true, 'pooled session binds to task')
  assert((await getCurrentConversationId(db, 't2', 'claude-code')) === 'POOL1', 'bound pool session is honored for its task')

  // 9. bind is set-once — a second bind is a no-op.
  const bound2 = await bindSessionToTask(db, { sessionId: 'POOL1', taskId: 't3', tabId: 't3' })
  assert(bound2 === false, 'second bind no-op (set-once, no reattach)')
  assert((await getCurrentConversationId(db, 't3', 'claude-code')) === null, 'session did not move to t3')

  console.log('OK — agent_sessions B-lifecycle checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
