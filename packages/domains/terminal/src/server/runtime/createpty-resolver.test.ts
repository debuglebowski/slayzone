/**
 * Integration test: the main-authoritative conversation resolver is WIRED into
 * createPty. With a null renderer hint but a ledger id (via the injected
 * resolver), the spawn must build the RESUME command — NOT mint a fresh session.
 * This is the end-to-end guard for the restart-clobber regression (resolver
 * registered + createPty consults it before the fresh-vs-resume branch). Uses a
 * fake adopted pty + stub db — no real shell spawns.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm <file>
 */
import type { PtySessionWindow } from '../pty-host'
import type { IPty } from 'node-pty'
import type { BatchOp, SlayzoneDb } from '@slayzone/platform'
import Database from 'better-sqlite3'
import { createPty, killPty, setDatabase, setConversationResolver } from './pty-manager'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${e}`)
    failed++
  }
}

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

interface FakePty {
  pid: number
  process: string
  written: string[]
  onData: (cb: (d: string) => void) => { dispose: () => void }
  onExit: (cb: (e: { exitCode: number }) => void) => { dispose: () => void }
  write: (s: string) => void
  kill: (sig?: string) => void
  resize: (c: number, r: number) => void
}
function makeFakePty(): FakePty {
  return {
    pid: 4242,
    process: 'zsh',
    written: [],
    onData() {
      return { dispose() {} }
    },
    onExit() {
      return { dispose() {} }
    },
    write(s) {
      this.written.push(s)
    },
    kill() {},
    resize() {}
  }
}

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: () => {} }
} as unknown as PtySessionWindow

// Tolerant stub: buildMcpEnv reads the project row; the spawn path may record a
// pending-spawn — all no-ops here.
const stubDb = {
  get: async () => ({ project_id: 'proj-1' }),
  all: async () => [],
  run: async () => ({ changes: 0, lastInsertRowid: 0 }),
  batchTxn: async (ops: unknown[]) => ops.map(() => undefined)
} as unknown as SlayzoneDb

setDatabase(stubDb)

await test('null renderer hint + ledger id → RESUME (no fresh mint)', async () => {
  setConversationResolver(async () => 'REAL-LEDGER-ID')
  const fake = makeFakePty()
  const sid = 'resTaskA:resTaskA'
  await createPty({
    win: fakeWin,
    sessionId: sid,
    cwd: '/tmp',
    mode: 'claude-code',
    type: 'claude-code',
    existingConversationId: undefined,
    conversationId: undefined,
    initialCommand: 'claude --session-id {id} {flags}',
    resumeCommand: 'claude --resume {id} {flags}',
    defaultFlags: '--allow-dangerously-skip-permissions',
    adoptPty: { pty: fake as unknown as IPty }
  })
  const cmd = fake.written.join('')
  expect(cmd.includes('--resume'), `expected resume template, got: ${cmd}`)
  expect(cmd.includes('REAL-LEDGER-ID'), `expected ledger id in command, got: ${cmd}`)
  expect(!cmd.includes('--session-id'), `must NOT fresh-spawn when ledger id known: ${cmd}`)
  killPty(sid)
  setConversationResolver(null)
})

await test('null hint + no ledger id → fresh mint (--session-id), not resume', async () => {
  setConversationResolver(async () => null)
  const fake = makeFakePty()
  const sid = 'resTaskB:resTaskB'
  await createPty({
    win: fakeWin,
    sessionId: sid,
    cwd: '/tmp',
    mode: 'claude-code',
    type: 'claude-code',
    existingConversationId: undefined,
    conversationId: undefined,
    initialCommand: 'claude --session-id {id} {flags}',
    resumeCommand: 'claude --resume {id} {flags}',
    defaultFlags: '--allow-dangerously-skip-permissions',
    adoptPty: { pty: fake as unknown as IPty }
  })
  const cmd = fake.written.join('')
  expect(cmd.includes('--session-id'), `expected fresh --session-id, got: ${cmd}`)
  expect(!cmd.includes('--resume'), `must NOT resume when nothing known: ${cmd}`)
  killPty(sid)
  setConversationResolver(null)
})

// ── Retry-on-flaky-resolver: the actual restart-clobber fix ──────────────────
// The production bug: on the first boot spawn the resolver returned null when
// the ledger HAD a real id (a transient read during heavy boot). The old test
// stubbed the resolver to always succeed, so it never covered this. These cover
// the retry that hardens the destructive fresh-mint decision against it.

async function spawnWithResolver(
  sid: string,
  resolver: () => Promise<string | null>
): Promise<string> {
  setConversationResolver(resolver)
  const fake = makeFakePty()
  await createPty({
    win: fakeWin,
    sessionId: sid,
    cwd: '/tmp',
    mode: 'claude-code',
    type: 'claude-code',
    existingConversationId: undefined,
    conversationId: undefined,
    initialCommand: 'claude --session-id {id} {flags}',
    resumeCommand: 'claude --resume {id} {flags}',
    defaultFlags: '--allow-dangerously-skip-permissions',
    adoptPty: { pty: fake as unknown as IPty }
  })
  const cmd = fake.written.join('')
  killPty(sid)
  setConversationResolver(null)
  return cmd
}

await test('retry: resolver null THEN real → resumes (boot-race fix)', async () => {
  let calls = 0
  const cmd = await spawnWithResolver('retryA:retryA', async () => {
    calls++
    return calls === 1 ? null : 'RETRIED-REAL'
  })
  expect(calls >= 2, `resolver must be retried after a transient null (calls=${calls})`)
  expect(cmd.includes('--resume'), `must resume after retry, got: ${cmd}`)
  expect(cmd.includes('RETRIED-REAL'), `must resume the retried id, got: ${cmd}`)
  expect(!cmd.includes('--session-id'), `must NOT fresh-mint when retry finds a real id: ${cmd}`)
})

await test('retry: resolver THROWS then real → resumes (db-not-ready)', async () => {
  let calls = 0
  const cmd = await spawnWithResolver('retryB:retryB', async () => {
    calls++
    if (calls === 1) throw new Error('db worker not ready')
    return 'AFTER-THROW'
  })
  expect(
    cmd.includes('--resume') && cmd.includes('AFTER-THROW'),
    `must resume after a thrown first attempt: ${cmd}`
  )
})

await test('retry is bounded: resolver ALWAYS null → fresh mint, no hang', async () => {
  let calls = 0
  const cmd = await spawnWithResolver('retryC:retryC', async () => {
    calls++
    return null
  })
  expect(calls === 3, `retry must be bounded to 3 attempts (calls=${calls})`)
  expect(cmd.includes('--session-id'), `genuinely-no-convo task must fresh-spawn: ${cmd}`)
  expect(!cmd.includes('--resume'), `must not resume when nothing is ever found: ${cmd}`)
})

// ── Real-db resolver chain (not a stub): a ledger READ drives the resume ──────
// Closes the gap the stubbed wiring test left: proves a resolver backed by a
// real async db read (the production shape) drives a resume when the renderer
// hint is absent. The canonical query lives + is unit-tested in
// task-conversations.test.ts (getCurrentConversationId); here we exercise the
// createPty ← resolver ← async-db integration without a reverse package import.
function makeAsyncDb(): SlayzoneDb {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, provider_config TEXT, claude_conversation_id TEXT, project_id TEXT);
    CREATE TABLE task_conversations (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, mode TEXT NOT NULL, conversation_id TEXT,
      origin TEXT NOT NULL, pending_meta TEXT, created_at INTEGER NOT NULL);
    -- v147 triple-write target: recordPendingSpawn → recordConversation mirrors
    -- into agent_sessions, so the table must exist for batchTxn (not tolerant).
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, cwd TEXT, task_id TEXT, conversation_id TEXT,
      origin TEXT NOT NULL, status TEXT NOT NULL, pending_meta TEXT, created_at INTEGER NOT NULL, bound_at INTEGER);
    CREATE TABLE session_resets (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, mode TEXT NOT NULL, created_at INTEGER NOT NULL);
  `)
  raw
    .prepare('INSERT INTO tasks (id, provider_config, project_id) VALUES (?, ?, ?)')
    .run('rt1', '{}', 'proj-1')
  // Tolerant get/all so buildMcpEnv's unrelated queries (missing tables here)
  // return empty instead of throwing — only the ledger queries need to be real.
  return {
    async get(sql: string, params: unknown[] = []) {
      try {
        return raw.prepare(sql).get(...params)
      } catch {
        return undefined
      }
    },
    async all(sql: string, params: unknown[] = []) {
      try {
        return raw.prepare(sql).all(...params)
      } catch {
        return []
      }
    },
    async run(sql: string, params: unknown[] = []) {
      const r = raw.prepare(sql).run(...params)
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
    },
    async batchTxn(ops: BatchOp[]) {
      return raw.transaction(() => ops.map((op) => raw.prepare(op.sql)[op.type](...op.params)))()
    }
  } as unknown as SlayzoneDb
}

await test('real-db resolver drives resume from the ledger (renderer hint absent)', async () => {
  const adb = makeAsyncDb()
  // Seed a honored ledger row for rt1 (a real conversation).
  await adb.run(
    `INSERT INTO task_conversations (id, task_id, mode, conversation_id, origin, created_at)
     VALUES ('row1','rt1','claude-code','REAL-LEDGER-ID','slay-spawned-fresh', 1000)`
  )
  setDatabase(adb)
  // Resolver shape registerConversationResolver wires in production: the
  // latest-honored-after-reset read, run against a real async db.
  setConversationResolver(async ({ taskId, mode }) => {
    const row = await adb.get<{ conversation_id: string | null }>(
      `WITH reset AS (
         SELECT max(created_at) AS at FROM task_conversations
         WHERE task_id=? AND mode=? AND origin='manual-reset')
       SELECT conversation_id FROM task_conversations
       WHERE task_id=? AND mode=?
         AND origin IN ('slay-spawned-fresh','slay-spawned-resume','cas-repoint-heal','legacy-migration')
         AND created_at > coalesce((SELECT at FROM reset),0)
       ORDER BY created_at DESC LIMIT 1`,
      [taskId, mode, taskId, mode]
    )
    return row?.conversation_id ?? null
  })
  const fake = makeFakePty()
  const sid = 'rt1:rt1'
  await createPty({
    win: fakeWin,
    sessionId: sid,
    cwd: '/tmp',
    mode: 'claude-code',
    type: 'claude-code',
    existingConversationId: undefined,
    conversationId: undefined,
    initialCommand: 'claude --session-id {id} {flags}',
    resumeCommand: 'claude --resume {id} {flags}',
    defaultFlags: '--allow-dangerously-skip-permissions',
    adoptPty: { pty: fake as unknown as IPty }
  })
  const cmd = fake.written.join('')
  expect(
    cmd.includes('--resume') && cmd.includes('REAL-LEDGER-ID'),
    `real resolver must resume the ledger id: ${cmd}`
  )
  expect(!cmd.includes('--session-id'), `must NOT fresh-spawn over the ledger id: ${cmd}`)
  killPty(sid)
  setConversationResolver(null)
  setDatabase(stubDb)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
