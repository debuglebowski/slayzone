/**
 * Session retention (T-23): session content older than
 * `SLAYZONE_HUB_SESSION_RETENTION_DAYS` is removed, once shortly after boot and then
 * once a day. `0` — the default, the desktop app's hub — creates no timer at all.
 *
 * SESSION CONTENT is the text that passed between a user and an agent, as the hub
 * stores it. Each row ages from `created_at`, the time it was written (a row is never
 * edited afterwards; `chat_events` re-stamps it on its INSERT OR REPLACE):
 *
 *   chat_events    chat-mode agent events: messages, tool calls, output   (TEXT, UTC)
 *   agent_prompts  prompts captured from the agent's prompt hook           (INTEGER, ms)
 *   chat_queue     chat messages queued but not sent yet                   (TEXT, UTC)
 *   agent_turns    `prompt_preview` only (first 200 chars of the prompt)   (INTEGER, ms)
 *
 * Terminal output is RAM only (`terminal_sessions` was dropped in v12), so there is no
 * terminal table to sweep.
 *
 * NEVER TOUCHED. Tasks, projects, notes, files and accounts have no retention (owner
 * decision O-7) and nothing else in this database is session content either. In
 * particular the session LEDGER stays — `agent_sessions`, `task_conversations`,
 * `session_turns`, `session_resets`, `session_deletions`: ids, modes, paths and times,
 * no text. It is the task's resume binding (a copy of which also lives in the task row,
 * `tasks.provider_config`), an append-only provenance record by design
 * (`task/server/ops/agent-sessions.ts`), and the row a live agent resolves its task
 * through (`getBoundTaskId`). The database cannot tell whether a bound session is still
 * running (`ended_at` is only ever set for warm-pool agents), so deleting by age could
 * cut a live agent off its task while removing no content. `usage_records` (token
 * counts, no text) is usage analytics' "all time" range and stays too.
 *
 * `agent_turns` rows stay with the preview blanked, not deleted: each pins a snapshot
 * ref in the user's repository (`refs/slayzone/turns/<id>`) that only the per-worktree
 * cap removes, together with its row (`agent-turns/server/turn-tracker.ts`).
 *
 * LIVE SESSIONS are not broken. A running chat transport keeps its buffer and next seq
 * in memory (the per-tab cap deletes its old rows the same way, in
 * `chat-events-store.ts`); a respawn after everything aged out starts at seq 0, like a
 * fresh conversation. A queued message that ages out is gone as if the user had removed
 * it. No foreign key points AT the swept tables, so nothing cascades out of them, and
 * the task they belong to still opens with less history.
 *
 * BOUNDED WORK. Each table is walked once in rowid order, {@link SWEEP_BATCH} rows per
 * statement — one statement is one transaction. better-sqlite3 is synchronous on the
 * hub's single connection, so the sweep yields to the event loop between batches:
 * requests and the hub's own writers run in between rather than behind a large first
 * sweep. No index on `created_at` (no migration): at a few users the walk is one read of
 * each table per day.
 *
 * DELETED MEANS GONE FROM THE FILE. SQLite leaves deleted content in free space —
 * freelist pages, and the unused part of a page a cell or a page split vacated — until
 * that space is reused. `PRAGMA secure_delete = ON` "overwrites deleted content with
 * zeros" (https://www.sqlite.org/pragma.html#pragma_secure_delete; FAST would leave
 * "forensic traces on freelist pages"). It is per connection and only covers what is
 * freed while it is on, so it is set on the hub's connection as soon as the sweep is
 * enabled at boot and stays on: the app's own caps and purges zero what they free too.
 * After each sweep `PRAGMA wal_checkpoint(TRUNCATE)` copies the zeroed pages into the
 * main file and cuts the WAL to zero bytes, dropping old frames that still hold content
 * (https://www.sqlite.org/pragma.html#pragma_wal_checkpoint). Not chosen:
 * `auto_vacuum=INCREMENTAL` + `incremental_vacuum` (switching an existing database
 * needs a full VACUUM, and moving pages does not zero them) and a full `VACUUM`
 * (https://www.sqlite.org/lang_vacuum.html — rewrites the whole database while holding
 * the hub's only connection, and needs up to twice its size on disk).
 *
 * LIMITS. Space freed before the sweep was first enabled is not zeroed after the fact;
 * on a database that already held sessions, run `VACUUM` once with the hub stopped.
 * Backups (`backups/`) are copies taken earlier and keep old rows until they are
 * deleted themselves; the sweep does not touch them.
 *
 * @module server/session-retention
 */
import type { SlayzoneDb } from '@slayzone/platform'
import { readHubSessionRetentionDays } from '@slayzone/platform/hub-switches'
import { securityEvent } from '@slayzone/platform/security-log'

/** Rows per statement. */
export const SWEEP_BATCH = 500
/** First sweep this long after boot: after the hub listens, out of the boot steps' way. */
export const BOOT_SWEEP_DELAY_MS = 5_000
/** Then once a day. */
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

interface Rule {
  table: 'chat_events' | 'agent_prompts' | 'chat_queue' | 'agent_turns'
  /** Over the table's own row; the one `?` is the cutoff. */
  expired: string
  /** `ms` = epoch milliseconds; `datetime` = SQLite `YYYY-MM-DD HH:MM:SS` UTC. */
  clock: 'ms' | 'datetime'
  /** Blank a column instead of deleting the row. */
  redact?: { column: string; set: string }
}

const RULES: readonly Rule[] = [
  // `datetime()` normalises whatever shape a writer used; an unparseable value is
  // NULL, never "older", so the row stays.
  { table: 'chat_events', expired: 'datetime(created_at) < ?', clock: 'datetime' },
  { table: 'agent_prompts', expired: 'created_at < ?', clock: 'ms' },
  { table: 'chat_queue', expired: 'datetime(created_at) < ?', clock: 'datetime' },
  {
    table: 'agent_turns',
    expired: "created_at < ? AND prompt_preview <> ''",
    clock: 'ms',
    redact: { column: 'prompt_preview', set: "prompt_preview = ''" }
  }
]

export interface SweepReport {
  days: number
  /** Rows written before this (ISO) were swept. */
  cutoff: string
  durationMs: number
  /** Rows deleted, by table. */
  deleted: Record<string, number>
  /** Rows whose content column was blanked, by table. */
  redacted: Record<string, number>
  /** Tables whose pass failed; the others still ran. */
  failed: string[]
  checkpoint: 'truncated' | 'busy' | 'no-wal' | 'failed'
}

/** `2026-07-24 03:00:00` — the shape of SQLite's `datetime('now')`. */
function sqliteDatetime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

/** One table, in rowid order, {@link SWEEP_BATCH} rows per statement. Returns rows changed. */
async function sweepTable(
  db: SlayzoneDb,
  rule: Rule,
  cutoff: number | string,
  batch: number,
  pause: () => Promise<boolean>
): Promise<number> {
  const change = rule.redact
    ? `UPDATE ${rule.table} SET ${rule.redact.set}`
    : `DELETE FROM ${rule.table}`
  // Rowids are positive unless a writer chose otherwise; none here does.
  let after = Number.MIN_SAFE_INTEGER
  let total = 0
  for (;;) {
    // Find the next batch's last rowid first, then change only up to it and only what
    // is still expired: the statement stays bounded even if rows arrive in between.
    const page = await db.get<{ last: number | null; n: number }>(
      `SELECT max(r) AS last, count(*) AS n FROM (
         SELECT rowid AS r FROM ${rule.table}
          WHERE rowid > ? AND ${rule.expired}
          ORDER BY rowid LIMIT ?)`,
      [after, cutoff, batch]
    )
    if (!page || page.last === null) return total
    const res = await db.run(`${change} WHERE rowid > ? AND rowid <= ? AND ${rule.expired}`, [
      after,
      page.last,
      cutoff
    ])
    total += res.changes
    if (page.n < batch) return total
    after = page.last
    if (!(await pause())) return total
  }
}

/**
 * One sweep: every rule, then the WAL checkpoint. A failing table is recorded in
 * `failed` and the others still run; this never rejects for a table's error.
 */
export async function sweepSessionContent(
  db: SlayzoneDb,
  opts: {
    days: number
    now?: number
    batchSize?: number
    /** Between batches; resolve false to stop early (hub shutting down). */
    pause?: () => Promise<boolean>
  }
): Promise<SweepReport> {
  const started = Date.now()
  const now = opts.now ?? started
  // Clamped at the epoch: a period longer than the clock goes back sweeps nothing,
  // instead of producing a date `Date` cannot represent.
  const cutoffMs = Math.max(0, now - opts.days * DAY_MS)
  const batch = opts.batchSize ?? SWEEP_BATCH
  const pause =
    opts.pause ?? (() => new Promise<boolean>((resolve) => setImmediate(() => resolve(true))))
  const report: SweepReport = {
    days: opts.days,
    cutoff: new Date(cutoffMs).toISOString(),
    durationMs: 0,
    deleted: {},
    redacted: {},
    failed: [],
    checkpoint: 'failed'
  }

  // Idempotent; also set when the schedule starts. Here as well so that a sweep never
  // frees content without zeroing it, whoever calls it.
  await db.exec('PRAGMA secure_delete = ON')

  for (const [i, rule] of RULES.entries()) {
    // Between tables too: a table's last scan and the next one's first are two statements.
    if (i > 0 && !(await pause())) break
    const cutoff = rule.clock === 'ms' ? cutoffMs : sqliteDatetime(cutoffMs)
    try {
      const n = await sweepTable(db, rule, cutoff, batch, pause)
      if (rule.redact) report.redacted[rule.table] = n
      else report.deleted[rule.table] = n
    } catch (err) {
      report.failed.push(rule.table)
      console.error(
        `[session-retention] ${rule.table} not swept, retried next sweep: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  try {
    // Waits (busy_timeout, 5 s) only for ANOTHER process reading the file; the hub's own
    // connection never blocks itself. `busy` = such a reader stayed: the zeroed pages are
    // in the WAL and reach the main file at the next checkpoint (SQLite's own, or the
    // next sweep's). `log` is -1 when the database is not in WAL mode (in-memory).
    const cp = await db.get<{ busy: number; log: number }>('PRAGMA wal_checkpoint(TRUNCATE)')
    report.checkpoint = cp?.busy ? 'busy' : cp?.log === -1 ? 'no-wal' : 'truncated'
  } catch (err) {
    console.error(
      `[session-retention] WAL checkpoint failed, retried next sweep: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  report.durationMs = Date.now() - started
  return report
}

/** The one audit line of a sweep: counts, cutoff, duration — never content. */
function auditSweep(report: SweepReport): void {
  const failed = report.failed.length > 0
  securityEvent({
    event: 'hub.retention.sweep',
    outcome: failed ? 'failure' : 'success',
    level: failed ? 'error' : 'info',
    actor: null,
    ip: null,
    route: null,
    targetKind: 'hub',
    targetId: null,
    // Table names are values, not keys: `security-log` drops any key matching /prompt/.
    detail: {
      days: report.days,
      cutoff: report.cutoff,
      durationMs: report.durationMs,
      deleted: Object.entries(report.deleted).map(([table, rows]) => ({ table, rows })),
      redacted: Object.entries(report.redacted).map(([table, rows]) => ({
        table,
        column: RULES.find((r) => r.table === table)?.redact?.column ?? null,
        rows
      })),
      failed: report.failed,
      checkpoint: report.checkpoint
    }
  })
}

/** The timer functions the schedule uses; swapped by tests. */
export interface RetentionTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

const realTimers: RetentionTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout)
}

export interface SessionRetentionHandle {
  /** The period in force; `0` = off, and no timer exists. */
  readonly days: number
  /** Sweep now, unless a sweep is running (then null). Never rejects. */
  runNow(): Promise<SweepReport | null>
  /** Clear the timers; a running sweep stops at its next batch. */
  stop(): void
}

/**
 * Start the schedule: a sweep {@link BOOT_SWEEP_DELAY_MS} after boot, then every
 * {@link SWEEP_INTERVAL_MS}. Never two at once — a tick that finds one running is
 * skipped. A failed sweep is logged and audited; the next tick is the retry. Nothing
 * here can throw into the boot or reject into the process.
 */
export function startSessionRetention(opts: {
  db: SlayzoneDb
  env?: NodeJS.ProcessEnv
  timers?: RetentionTimers
  batchSize?: number
}): SessionRetentionHandle {
  const { db } = opts
  const timers = opts.timers ?? realTimers
  const setting = readHubSessionRetentionDays(opts.env ?? process.env)
  // Boot rule B16 already refused a malformed value; this is the second line: never
  // delete on a value nobody validated.
  const days = setting.ok ? setting.days : 0
  if (!setting.ok) console.error(`${setting.message} Session retention stays off.`)
  if (days === 0) {
    return {
      days: 0,
      runNow: async () => null,
      stop: () => {
        // Off: no timer was created, nothing to clear.
      }
    }
  }

  // From now on, everything this connection frees is zeroed — see the module note.
  void db.exec('PRAGMA secure_delete = ON').catch((err: unknown) => {
    console.error(
      `[session-retention] secure_delete not enabled: ${err instanceof Error ? err.message : String(err)}`
    )
  })

  let running = false
  let stopped = false
  const runNow = async (): Promise<SweepReport | null> => {
    if (stopped) return null
    if (running) {
      console.warn('[session-retention] previous sweep still running; this tick is skipped')
      return null
    }
    running = true
    try {
      const report = await sweepSessionContent(db, {
        days,
        batchSize: opts.batchSize,
        pause: () => new Promise<boolean>((resolve) => setImmediate(() => resolve(!stopped)))
      })
      auditSweep(report)
      return report
    } catch (err) {
      // Only the secure_delete pragma can land here: per-table errors are in the report.
      console.error(
        `[session-retention] sweep failed, retried next tick: ${err instanceof Error ? err.message : String(err)}`
      )
      auditSweep({
        days,
        cutoff: new Date(Math.max(0, Date.now() - days * DAY_MS)).toISOString(),
        durationMs: 0,
        deleted: {},
        redacted: {},
        failed: RULES.map((r) => r.table),
        checkpoint: 'failed'
      })
      return null
    } finally {
      running = false
    }
  }
  const tick = (): void => {
    void runNow()
  }

  // Both unref'd: a retention timer must never be what keeps the hub alive.
  const unref = (h: unknown): unknown => {
    ;(h as { unref?: () => void } | null)?.unref?.()
    return h
  }
  const boot = unref(timers.setTimeout(tick, BOOT_SWEEP_DELAY_MS))
  const daily = unref(timers.setInterval(tick, SWEEP_INTERVAL_MS))
  console.log(
    `[session-retention] session content older than ${days} day(s) is deleted: first sweep in ${BOOT_SWEEP_DELAY_MS / 1000}s, then daily`
  )

  return {
    days,
    runNow,
    stop: () => {
      stopped = true
      timers.clearTimeout(boot)
      timers.clearInterval(daily)
    }
  }
}
