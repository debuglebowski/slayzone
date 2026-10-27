/**
 * Session retention (session-retention.ts) against a real migrated database:
 *
 *   - per table, a row 91 days old is swept and one 89 days old is kept (and the
 *     boundary is the period itself, an hour either side);
 *   - nothing else changes: tasks, projects, notes, files, the session ledger and
 *     every other table are byte-identical, no foreign key is left dangling, and the
 *     task still opens — its sessions, prompts and chat history read fine;
 *   - a live session keeps working: its ledger row still resolves its task and its
 *     resume target, and its chat history keeps its seq;
 *   - `0` (and unset, the desktop default) deletes nothing and creates no timer;
 *   - the boot sweep and the daily tick both run (fake timers), never two at once, and
 *     a failing sweep is logged and audited, then the next tick retries;
 *   - statements stay bounded to the batch size;
 *   - one audit line per sweep, with counts, cutoff and duration and no content;
 *   - deleted content is gone from the database file and its WAL (byte search).
 *
 * Native ABI: better-sqlite3 built for Electron, so this runs under Electron's node
 * like ownership-backfill.test.ts.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts \
 *     packages/apps/hub/src/session-retention.test.ts
 */
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, assert, expect, test } from 'vitest'
import { DB_PRAGMAS, type SlayzoneDb } from '@slayzone/platform'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { getCurrentConversationId, getTaskOp, listTaskSessions } from '@slayzone/task/server'
import { createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness.js'
import { runMigrations } from '../../../shared/transport/src/db-bootstrap/migrations.js'
import {
  getNextSeqForTab,
  loadChatEvents,
  persistChatEvent
} from '../../../domains/terminal/src/server/chat-events-store.js'
import { listPromptsForTask } from '../../../domains/agent-turns/src/server/prompt-db.js'
import {
  BOOT_SWEEP_DELAY_MS,
  SWEEP_INTERVAL_MS,
  startSessionRetention,
  sweepSessionContent,
  type RetentionTimers,
  type SweepReport
} from './session-retention.js'

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const ON = { SLAYZONE_HUB_SESSION_RETENTION_DAYS: '90' }
const SWEPT = new Set(['chat_events', 'agent_prompts', 'chat_queue', 'agent_turns'])

/** `datetime('now')` shape, for the TEXT clocks. */
const sqlTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

const tmpDirs: string[] = []
interface TestDb {
  raw: Database.Database
  db: SlayzoneDb
  file: string
}
/** A migrated database in a real file (WAL, like the hub's), so its bytes can be read. */
function newDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'session-retention-'))
  tmpDirs.push(dir)
  const file = join(dir, 'slayzone.data.sqlite')
  const raw = new Database(file)
  for (const p of DB_PRAGMAS) raw.pragma(p)
  runMigrations(raw)
  return { raw, db: createSlayzoneDbAdapter(raw), file }
}

/**
 * A project, a task with a description and a file, a chat tab, and session content at
 * `oldAge` and `newAge`. Two sessions: one that ended long ago, and a live one that
 * started long ago and never ended (the database cannot tell it is still running).
 */
function seed(raw: Database.Database, now: number, oldAge: number, newAge: number): void {
  const old = now - oldAge
  const recent = now - newAge
  raw.prepare(`INSERT INTO projects (id, name, color) VALUES ('p1', 'Project', '#111111')`).run()
  raw
    .prepare(
      `INSERT INTO tasks (id, project_id, title, status, priority, description, created_at)
       VALUES ('t1', 'p1', 'Task', 'in_progress', 3, 'NOTE-KEEP task notes', ?)`
    )
    .run(sqlTime(now - 400 * DAY))
  raw
    .prepare(
      `INSERT INTO task_artifacts (id, task_id, title, created_at) VALUES ('a1', 't1', 'FILE-KEEP', ?)`
    )
    .run(sqlTime(now - 400 * DAY))
  raw
    .prepare(`INSERT INTO test_file_notes (project_id, file_path, note) VALUES ('p1', 'x.ts', 'n')`)
    .run()
  raw
    .prepare(
      `INSERT INTO terminal_tabs (id, task_id, mode, is_main, created_at) VALUES ('tab1', 't1', 'claude-code', 1, ?)`
    )
    .run(sqlTime(now - 300 * DAY))

  const event = raw.prepare(
    'INSERT INTO chat_events (tab_id, seq, event, created_at) VALUES (?, ?, ?, ?)'
  )
  for (let seq = 0; seq < 3; seq++) {
    event.run('tab1', seq, JSON.stringify({ type: 'text', text: `GONE-chat-${seq}` }), sqlTime(old))
  }
  for (let seq = 3; seq < 5; seq++) {
    event.run(
      'tab1',
      seq,
      JSON.stringify({ type: 'text', text: `KEEP-chat-${seq}` }),
      sqlTime(recent)
    )
  }

  const prompt = raw.prepare(
    `INSERT INTO agent_prompts (id, task_id, agent_id, cli_session_id, text, created_at)
     VALUES (?, 't1', 'claude-code', ?, ?, ?)`
  )
  prompt.run('pr-old', 'conv-old', 'GONE-prompt', old)
  prompt.run('pr-new', 'conv-live', 'KEEP-prompt', recent)

  const queue = raw.prepare(
    `INSERT INTO chat_queue (id, tab_id, send, original, position, created_at) VALUES (?, 'tab1', ?, ?, ?, ?)`
  )
  queue.run('q-old', 'GONE-queue-send', 'GONE-queue-original', 0, sqlTime(old))
  queue.run('q-new', 'KEEP-queue-send', 'KEEP-queue-original', 1, sqlTime(recent))

  const turn = raw.prepare(
    `INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, head_sha_at_snap, prompt_preview, created_at)
     VALUES (?, '/repo', 't1', 'tab1', ?, 'head', ?, ?)`
  )
  turn.run('turn-old', 'sha-old', 'GONE-turn-preview', old)
  turn.run('turn-new', 'sha-new', 'KEEP-turn-preview', recent)

  const session = raw.prepare(
    `INSERT INTO agent_sessions (id, mode, cwd, task_id, conversation_id, origin, status, created_at, bound_at, tab_id, ended_at)
     VALUES (?, 'claude-code', '/repo', 't1', ?, 'slay-spawned-fresh', ?, ?, ?, 'tab1', ?)`
  )
  session.run('s-old', 'conv-old', 'dead', now - 200 * DAY, now - 200 * DAY, now - 120 * DAY)
  session.run('s-live', 'conv-live', 'bound', now - 150 * DAY, now - 150 * DAY, null)
  const firstTurn = raw.prepare(
    'INSERT INTO session_turns (conversation_id, first_turn_at) VALUES (?, ?)'
  )
  firstTurn.run('conv-old', now - 200 * DAY)
  firstTurn.run('conv-live', now - 150 * DAY)
  raw
    .prepare(
      `INSERT INTO usage_records (id, provider, model, session_id, timestamp, source_file)
       VALUES ('u1', 'claude', 'm', 'conv-old', ?, '/x.jsonl')`
    )
    .run(new Date(now - 300 * DAY).toISOString())
}

/** Every table except the four the sweep owns, as rows. */
function snapshotOthers(raw: Database.Database): Record<string, string> {
  const out: Record<string, string> = {}
  const tables = raw
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[]
  for (const { name } of tables) {
    if (SWEPT.has(name)) continue
    out[name] = JSON.stringify(raw.prepare(`SELECT * FROM "${name}"`).all())
  }
  return out
}

/** Timers that only record; `fire` runs a callback the way the clock would. */
function fakeTimers(): {
  timers: RetentionTimers
  scheduled: {
    kind: 'timeout' | 'interval'
    ms: number
    fn: () => void
    unrefs: number
    cleared: boolean
  }[]
} {
  const scheduled: {
    kind: 'timeout' | 'interval'
    ms: number
    fn: () => void
    unrefs: number
    cleared: boolean
  }[] = []
  const make = (kind: 'timeout' | 'interval', fn: () => void, ms: number) => {
    const h = {
      kind,
      ms,
      fn,
      unrefs: 0,
      cleared: false,
      unref() {
        h.unrefs++
      }
    }
    scheduled.push(h)
    return h
  }
  const clear = (h: unknown): void => {
    ;(h as { cleared: boolean }).cleared = true
  }
  return {
    scheduled,
    timers: {
      setTimeout: (fn, ms) => make('timeout', fn, ms),
      setInterval: (fn, ms) => make('interval', fn, ms),
      clearTimeout: clear,
      clearInterval: clear
    }
  }
}

const audit: string[] = []
setSecurityLogSink((line) => audit.push(line))
const sweepLines = (): Array<Record<string, unknown>> =>
  audit
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.event === 'hub.retention.sweep')

async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error(`timed out waiting for ${label}`)
}

let unhandled = 0
process.on('unhandledRejection', () => {
  unhandled++
})

test('91 days old is swept and 89 days old is kept, per table', async () => {
  const { raw, db } = newDb()
  seed(raw, Date.now(), 91 * DAY, 89 * DAY)
  const handle = startSessionRetention({ db, env: ON, timers: fakeTimers().timers })
  const report = await handle.runNow()
  assert(report, 'a sweep ran')

  const seqs = (
    raw.prepare('SELECT seq FROM chat_events ORDER BY seq').all() as { seq: number }[]
  ).map((r) => r.seq)
  expect(seqs, 'chat_events: the 91-day events went, the 89-day ones stayed').toEqual([3, 4])
  expect(raw.prepare('SELECT id FROM agent_prompts ORDER BY id').all(), 'agent_prompts').toEqual([
    { id: 'pr-new' }
  ])
  expect(raw.prepare('SELECT id FROM chat_queue ORDER BY id').all(), 'chat_queue').toEqual([
    { id: 'q-new' }
  ])
  expect(
    raw.prepare('SELECT id, snapshot_sha, prompt_preview FROM agent_turns ORDER BY id').all(),
    'agent_turns: both rows (and their snapshot) stay, the old preview is blanked'
  ).toEqual([
    { id: 'turn-new', snapshot_sha: 'sha-new', prompt_preview: 'KEEP-turn-preview' },
    { id: 'turn-old', snapshot_sha: 'sha-old', prompt_preview: '' }
  ])
  expect(
    { deleted: report.deleted, redacted: report.redacted, failed: report.failed },
    'report counts'
  ).toEqual({
    deleted: { chat_events: 3, agent_prompts: 1, chat_queue: 1 },
    redacted: { agent_turns: 1 },
    failed: []
  })
  handle.stop()
})

test('the boundary is the period itself: 90 days plus an hour goes, minus an hour stays', async () => {
  const { raw, db } = newDb()
  seed(raw, Date.now(), 90 * DAY + HOUR, 90 * DAY - HOUR)
  const report = await sweepSessionContent(db, { days: 90 })
  expect(
    { deleted: report.deleted, redacted: report.redacted },
    'only the rows past the cutoff, on the TEXT and the ms clocks alike'
  ).toEqual({
    deleted: { chat_events: 3, agent_prompts: 1, chat_queue: 1 },
    redacted: { agent_turns: 1 }
  })
})

test('nothing else changes; no dangling keys; the task still opens', async () => {
  const { raw, db } = newDb()
  const now = Date.now()
  seed(raw, now, 91 * DAY, 89 * DAY)
  const before = snapshotOthers(raw)
  const currentBefore = await getCurrentConversationId(db, 't1', 'claude-code')
  await sweepSessionContent(db, { days: 90, now })

  const after = snapshotOthers(raw)
  for (const table of Object.keys(before)) {
    expect(before[table], `${table} is unchanged`).toBe(after[table])
  }
  expect(raw.pragma('foreign_key_check'), 'no row points at a missing parent').toEqual([])

  const task = await getTaskOp(db, 't1')
  assert(task, 'the task loads')
  expect(task.description, 'its notes are intact').toBe('NOTE-KEEP task notes')
  const sessions = await listTaskSessions(db, 't1', 'claude-code')
  expect(
    sessions.map((s) => [s.conversationId, s.messageCount, s.firstPrompt, s.isCurrent]),
    'both sessions still listed; the old one has no messages left'
  ).toEqual([
    ['conv-live', 1, 'KEEP-prompt', true],
    ['conv-old', 0, null, false]
  ])
  expect(
    (await listPromptsForTask(db, 't1', 'claude-code')).map((p) => p.text),
    'the message history holds the recent prompt'
  ).toEqual(['KEEP-prompt'])
  expect(
    (await loadChatEvents(db, 'tab1')).map((e) => e.seq),
    'the chat history loads what is left'
  ).toEqual([3, 4])
  expect(currentBefore, 'resume target before').toBe('conv-live')
  expect(await getCurrentConversationId(db, 't1', 'claude-code'), 'resume target after').toBe(
    'conv-live'
  )
})

test('a live session keeps working: its task, its resume target, its chat seq', async () => {
  const { raw, db } = newDb()
  const now = Date.now()
  seed(raw, now, 91 * DAY, 89 * DAY)
  const nextBefore = await getNextSeqForTab(db, 'tab1')
  await sweepSessionContent(db, { days: 90, now })

  // The live agent's ledger row — started 150 days ago, never ended, bound to its
  // task — is the task's resume binding, and the sweep does not touch it.
  expect(
    raw.prepare('SELECT status, ended_at, task_id FROM agent_sessions WHERE id = ?').get('s-live'),
    'the live session row is as it was'
  ).toEqual({ status: 'bound', ended_at: null, task_id: 't1' })
  expect(await getNextSeqForTab(db, 'tab1'), 'next chat seq is unchanged').toEqual(nextBefore)
  await persistChatEvent(db, 'tab1', nextBefore, { type: 'text', text: 'after' } as never)
  expect(
    (await loadChatEvents(db, 'tab1')).map((e) => e.seq),
    'the live tab keeps appending in order'
  ).toEqual([3, 4, 5])
})

test('0 and unset (the desktop default): nothing deleted, no timer', async () => {
  for (const env of [{}, { SLAYZONE_HUB_SESSION_RETENTION_DAYS: '0' }]) {
    const { raw, db } = newDb()
    seed(raw, Date.now(), 400 * DAY, 300 * DAY)
    const fake = fakeTimers()
    const lines = sweepLines().length
    const handle = startSessionRetention({ db, env, timers: fake.timers })
    expect(handle.days, `${JSON.stringify(env)}: off`).toBe(0)
    expect(fake.scheduled.length, `${JSON.stringify(env)}: no timer`).toBe(0)
    expect(await handle.runNow(), `${JSON.stringify(env)}: runNow does nothing`).toBe(null)
    expect(raw.pragma('secure_delete', { simple: true }), 'connection left as it was').toBe(0)
    expect(
      raw.prepare('SELECT count(*) AS n FROM chat_events').get(),
      `${JSON.stringify(env)}: every chat event kept`
    ).toEqual({ n: 5 })
    expect(sweepLines().length, 'no audit line').toEqual(lines)
  }
})

test('a malformed period is never treated as a period', async () => {
  const { raw, db } = newDb()
  seed(raw, Date.now(), 400 * DAY, 300 * DAY)
  const fake = fakeTimers()
  const handle = startSessionRetention({
    db,
    env: { SLAYZONE_HUB_SESSION_RETENTION_DAYS: '90d' },
    timers: fake.timers
  })
  expect([handle.days, fake.scheduled.length], 'off, no timer (B16 refused it at boot)').toEqual([
    0, 0
  ])
  expect(raw.prepare('SELECT count(*) AS n FROM agent_prompts').get(), 'kept').toEqual({ n: 2 })
})

test('boot sweep, then the daily tick; timers unref’d; stop clears them', async () => {
  const { raw, db } = newDb()
  seed(raw, Date.now(), 91 * DAY, 89 * DAY)
  const fake = fakeTimers()
  const handle = startSessionRetention({ db, env: ON, timers: fake.timers })
  expect(handle.days, 'on').toBe(90)
  expect(raw.pragma('secure_delete', { simple: true }), 'secure_delete on from the start').toBe(1)
  expect(
    fake.scheduled.map((t) => [t.kind, t.ms, t.unrefs]),
    'one boot timeout, one daily interval, both unref’d'
  ).toEqual([
    ['timeout', BOOT_SWEEP_DELAY_MS, 1],
    ['interval', SWEEP_INTERVAL_MS, 1]
  ])
  expect(SWEEP_INTERVAL_MS, 'daily').toEqual(DAY)

  const lines = sweepLines().length
  fake.scheduled[0].fn()
  await until(() => sweepLines().length === lines + 1, 'the boot sweep')
  expect(raw.prepare('SELECT count(*) AS n FROM agent_prompts').get(), 'boot sweep ran').toEqual({
    n: 1
  })

  raw
    .prepare(
      `INSERT INTO agent_prompts (id, task_id, agent_id, text, created_at) VALUES ('pr-later', 't1', 'claude-code', 'x', ?)`
    )
    .run(Date.now() - 100 * DAY)
  fake.scheduled[1].fn()
  await until(() => sweepLines().length === lines + 2, 'the daily sweep')
  expect(raw.prepare('SELECT count(*) AS n FROM agent_prompts').get(), 'daily sweep ran').toEqual({
    n: 1
  })

  handle.stop()
  expect(
    fake.scheduled.every((t) => t.cleared),
    'stop cleared both timers'
  ).toBe(true)
  expect(await handle.runNow(), 'nothing runs after stop').toBe(null)
})

test('never two sweeps at once', async () => {
  const { raw, db } = newDb()
  seed(raw, Date.now(), 91 * DAY, 89 * DAY)
  const handle = startSessionRetention({ db, env: ON, timers: fakeTimers().timers })
  const lines = sweepLines().length
  const first = handle.runNow()
  const second = handle.runNow()
  expect(await second, 'the overlapping tick is skipped').toBe(null)
  expect(await first, 'the first sweep completes').toBeTruthy()
  expect(sweepLines().length, 'one sweep, one audit line').toEqual(lines + 1)
  expect(await handle.runNow(), 'the next tick runs again').toBeTruthy()
  handle.stop()
})

test('statements stay bounded by the batch size, yielding in between', async () => {
  const { raw, db } = newDb()
  const now = Date.now()
  seed(raw, now, 91 * DAY, 89 * DAY)
  const insert = raw.prepare(
    `INSERT INTO agent_prompts (id, task_id, agent_id, text, created_at) VALUES (?, 't1', 'claude-code', 'x', ?)`
  )
  for (let i = 0; i < 11; i++) insert.run(`bulk-${i}`, now - 95 * DAY)
  const changes: number[] = []
  const counting: SlayzoneDb = {
    ...db,
    run: async (sql, params) => {
      const r = await db.run(sql, params)
      if (/^DELETE FROM agent_prompts/.test(sql)) changes.push(r.changes)
      return r
    }
  }
  let pauses = 0
  const report = await sweepSessionContent(counting, {
    days: 90,
    now,
    batchSize: 5,
    pause: async () => {
      pauses++
      return true
    }
  })
  expect(changes, 'twelve rows in three statements of at most five').toEqual([5, 5, 2])
  expect(report.deleted.agent_prompts, 'all of them').toBe(12)
  expect(pauses, `yielded between batches (${pauses})`).toBeGreaterThanOrEqual(2)
})

test('a failing table is logged and audited; the others run; the next tick retries', async () => {
  const { raw, db } = newDb()
  seed(raw, Date.now(), 91 * DAY, 89 * DAY)
  const broken: SlayzoneDb = {
    ...db,
    get: async (sql, params) => {
      if (sql.includes('chat_queue')) throw new Error('SQLITE_IOERR: disk I/O error')
      return db.get(sql, params)
    }
  }
  const lines = sweepLines().length
  const handle = startSessionRetention({ db: broken, env: ON, timers: fakeTimers().timers })
  const report = await handle.runNow()
  assert(report, 'the sweep still reports')
  expect(report.failed, 'only chat_queue failed').toEqual(['chat_queue'])
  expect(report.deleted.agent_prompts, 'the other tables were swept').toBe(1)
  expect(raw.prepare('SELECT count(*) AS n FROM chat_queue').get(), 'queue not swept').toEqual({
    n: 2
  })
  const line = sweepLines()[lines]
  expect([line.outcome, line.level], 'audited as a failure').toEqual(['failure', 'error'])
  handle.stop()

  const retry = startSessionRetention({ db, env: ON, timers: fakeTimers().timers })
  const again = await retry.runNow()
  expect(again?.deleted.chat_queue, 'the next tick sweeps it').toBe(1)
  retry.stop()
})

test('a sweep that cannot run at all never rejects or crashes the hub', async () => {
  const { db } = newDb()
  const dead: SlayzoneDb = {
    ...db,
    exec: async () => {
      throw new Error('The database connection is not open')
    }
  }
  const fake = fakeTimers()
  const lines = sweepLines().length
  const before = unhandled
  const handle = startSessionRetention({ db: dead, env: ON, timers: fake.timers })
  fake.scheduled[0].fn()
  await until(() => sweepLines().length === lines + 1, 'the failure line')
  expect(sweepLines()[lines].outcome, 'audited').toBe('failure')
  expect(await handle.runNow(), 'runNow resolves null').toBe(null)
  await new Promise((r) => setImmediate(r))
  expect(unhandled, 'no unhandled rejection').toEqual(before)
  handle.stop()
})

test('one audit line per sweep: counts, cutoff and duration, no content', async () => {
  const { raw, db } = newDb()
  const now = Date.now()
  seed(raw, now, 91 * DAY, 89 * DAY)
  const handle = startSessionRetention({ db, env: ON, timers: fakeTimers().timers })
  const start = audit.length
  const report = (await handle.runNow()) as SweepReport
  const lines = audit.slice(start)
  expect(lines.length, 'exactly one line').toBe(1)
  const line = JSON.parse(lines[0]) as {
    event: string
    outcome: string
    actor: unknown
    targetKind: string
    detail: Record<string, unknown>
  }
  expect([line.event, line.outcome, line.actor, line.targetKind], 'envelope').toEqual([
    'hub.retention.sweep',
    'success',
    null,
    'hub'
  ])
  expect(line.detail.deleted, 'per-table counts, agent_prompts included').toEqual([
    { table: 'chat_events', rows: 3 },
    { table: 'agent_prompts', rows: 1 },
    { table: 'chat_queue', rows: 1 }
  ])
  expect(line.detail.redacted, 'redaction count').toEqual([
    { table: 'agent_turns', column: 'prompt_preview', rows: 1 }
  ])
  expect(line.detail.days, 'period').toBe(90)
  expect(line.detail.cutoff, 'cutoff').toEqual(report.cutoff)
  expect(
    Math.abs(Date.parse(report.cutoff) - (Date.now() - 90 * DAY)),
    'cutoff is 90 days back'
  ).toBeLessThan(60_000)
  expect(typeof line.detail.durationMs, 'duration').toBe('number')
  expect(lines[0], 'no content in the line').not.toMatch(/GONE-|KEEP-/)
  handle.stop()
})

/** Every occurrence of `needle` in the database file and its WAL. */
function onDisk(file: string, needle: string): number {
  let n = 0
  for (const f of [file, `${file}-wal`]) {
    if (!existsSync(f)) continue
    const buf = readFileSync(f)
    for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, i + 1)) n++
  }
  return n
}

/** Content in many pages (splits) and in overflow pages (over a page each). */
function seedBulk(raw: Database.Database, now: number): void {
  const prompt = raw.prepare(
    `INSERT INTO agent_prompts (id, task_id, agent_id, text, created_at) VALUES (?, 't1', 'claude-code', ?, ?)`
  )
  const event = raw.prepare(
    'INSERT INTO chat_events (tab_id, seq, event, created_at) VALUES (?, ?, ?, ?)'
  )
  for (let i = 0; i < 200; i++) {
    const old = i % 2 === 0
    const tag = old ? 'GONE-bulk' : 'KEEP-bulk'
    const pad = 'z'.repeat(i % 10 === 0 ? 9000 : 300)
    prompt.run(`bulk-${i}`, `${tag}-${i}-${pad}`, now - (old ? 120 : 10) * DAY)
    event.run(
      'tab1',
      100 + i,
      JSON.stringify({ text: `${tag}-${i}-${pad}` }),
      sqlTime(now - (old ? 120 : 10) * DAY)
    )
  }
}

test('deleted content is gone from the file and the WAL (byte search)', async () => {
  const { raw, db, file } = newDb()
  const now = Date.now()
  // As at boot: the schedule starts (secure_delete on) before content is written.
  const handle = startSessionRetention({ db, env: ON, timers: fakeTimers().timers })
  seed(raw, now, 91 * DAY, 89 * DAY)
  seedBulk(raw, now)
  raw.pragma('wal_checkpoint(TRUNCATE)')
  expect(onDisk(file, 'GONE-'), 'the old content is on disk before the sweep').toBeGreaterThan(0)

  const report = (await handle.runNow()) as SweepReport
  expect(report.checkpoint, 'WAL checkpointed and truncated').toBe('truncated')
  expect(onDisk(file, 'GONE-'), 'no byte of swept content left in the file or the WAL').toBe(0)
  expect(
    onDisk(file, 'KEEP-bulk-1-'),
    'kept content is still found (the search works)'
  ).toBeGreaterThan(0)
  expect(existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0, 'WAL is empty').toBe(0)
  handle.stop()
})

test('control: a plain delete leaves the content in the file', async () => {
  const { raw, file } = newDb()
  const now = Date.now()
  seed(raw, now, 91 * DAY, 89 * DAY)
  seedBulk(raw, now)
  raw.prepare(`DELETE FROM agent_prompts WHERE text LIKE 'GONE-%'`).run()
  raw.pragma('wal_checkpoint(TRUNCATE)')
  expect(
    onDisk(file, 'GONE-bulk-0-'),
    'without secure_delete the deleted text is still there'
  ).toBeGreaterThan(0)
})

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  setSecurityLogSink()
})
