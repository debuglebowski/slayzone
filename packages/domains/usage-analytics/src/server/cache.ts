import type { SlayzoneDb } from '@slayzone/platform'
import type { UsageRecord, AnalyticsSummary, DateRange } from '../shared/types'
import type { ParseResult, UsageCursors } from './collect'

/** Hub v209: the hub's former cursors, handed to each computer once, then dropped. */
const HANDOFF = 'usage_cursor_handoff'
/** The hub's own disk in the handoff (`computer_id` ''): the hub machine's computer reads it. */
const HUB_DISK = ''

/** Where a paged collect continues, or which page an `ack` confirms. */
export interface UsageCollectPage {
  token: string
  index: number
}

/** One request: the first (optionally seeding), a further `page`, and/or an `ack`. */
export interface UsageCollectRequest {
  page?: UsageCollectPage
  ack?: UsageCollectPage
  seed?: UsageCursors
}

/** One page of a collect: `complete: false` = more of that file follows. */
export interface UsageCollectReply {
  results: Array<ParseResult & { complete?: boolean }>
  next?: UsageCollectPage
  /** Send back as `ack` once this page is stored: only then do its cursors move. */
  receipt?: UsageCollectPage
}

/**
 * Where usage logs are parsed: on each connected computer (`usage.collect`), wired by
 * the hub's composition. Each computer keeps its own read offsets (robustness plan
 * §9, P0; v209); the hub stores the records and acknowledges each page. Unwired: no
 * computer, nothing to collect.
 */
export interface UsageCollectRouting {
  /** The computers to ask this refresh (connected ones). */
  computers(): readonly string[]
  collect(computerId: string, request: UsageCollectRequest): Promise<UsageCollectReply>
  /**
   * The computer on this hub's own machine (the desktop's local computer): it reads
   * the files the hub's old hub-disk cursors (computer_id '') point into, so it is
   * handed those too instead of re-parsing every log.
   */
  localComputerId?(): string | null
}

let routing: UsageCollectRouting | null = null

export function setUsageCollectRouting(next: UsageCollectRouting | null): void {
  routing = next
}

async function handoffExists(db: SlayzoneDb): Promise<boolean> {
  return Boolean(
    await db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [HANDOFF])
  )
}

/**
 * The hub's former cursors this computer is still owed (v209): its own rows, plus the
 * hub-disk rows for the hub machine's own computer. Null when nothing is owed.
 */
async function owedCursors(
  db: SlayzoneDb,
  computerId: string,
  isLocal: boolean
): Promise<UsageCursors | null> {
  if (!(await handoffExists(db))) return null
  const rows = (await db.all(
    `SELECT computer_id, file_path, last_offset, last_modified_ms FROM ${HANDOFF}
      WHERE computer_id = ? OR (? AND computer_id = ?)`,
    [computerId, isLocal ? 1 : 0, HUB_DISK]
  )) as Array<{
    computer_id: string
    file_path: string
    last_offset: number
    last_modified_ms: number
  }>
  if (!rows.length) return null
  const out: UsageCursors = {}
  // The computer's own row wins over a hub-disk row for the same file: hub-disk first.
  for (const own of [false, true])
    for (const r of rows)
      if ((r.computer_id !== HUB_DISK) === own)
        out[r.file_path] = { offset: r.last_offset, modifiedMs: r.last_modified_ms }
  return out
}

/** The computer took them (it answered the seeding request): forget them; drop the table once empty. */
async function handedOver(db: SlayzoneDb, computerId: string, isLocal: boolean): Promise<void> {
  await db.run(`DELETE FROM ${HANDOFF} WHERE computer_id = ? OR (? AND computer_id = ?)`, [
    computerId,
    isLocal ? 1 : 0,
    HUB_DISK
  ])
  if (!(await db.get(`SELECT 1 FROM ${HANDOFF} LIMIT 1`))) await db.run(`DROP TABLE ${HANDOFF}`)
}

async function upsertRecords(
  db: SlayzoneDb,
  records: UsageRecord[],
  sourceFile: string
): Promise<number> {
  if (records.length === 0) return 0

  const sql = `
    INSERT OR IGNORE INTO usage_records (
      id, provider, model, session_id, timestamp,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
      cost_usd, cwd, task_id, source_file, source_offset
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0)
  `

  const results = await db.batchTxn(
    records.map((r) => ({
      type: 'run' as const,
      sql,
      params: [
        r.id,
        r.provider,
        r.model,
        r.sessionId,
        r.timestamp,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
        r.cacheWriteTokens,
        r.reasoningTokens,
        r.cwd,
        r.taskId,
        sourceFile
      ]
    }))
  )

  let inserted = 0
  for (const result of results) {
    inserted += (result as { changes: number }).changes
  }
  return inserted
}

/** One refresh at a time: two overlapping refreshes would parse the same bytes twice. */
let inFlight: Promise<void> | null = null

export function refreshUsageData(db: SlayzoneDb): Promise<void> {
  inFlight ??= refresh(db).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function refresh(db: SlayzoneDb): Promise<void> {
  // Each computer parses its own logs from the read offsets it keeps (v209).
  const r = routing
  if (!r) return
  const local = r.localComputerId?.() ?? null

  for (const computerId of r.computers()) {
    const isLocal = computerId === local
    const seed = await owedCursors(db, computerId, isLocal)
    let request: UsageCollectRequest = seed ? { seed } : {}
    // Page by page: each page is stored, then acknowledged (with the next request,
    // or alone after the last), so its cursors move only once its records are here.
    for (;;) {
      let reply: UsageCollectReply
      try {
        reply = await r.collect(computerId, request)
      } catch {
        break // unreachable now: its cursors did not move, the next refresh resumes
      }
      if (request.seed) await handedOver(db, computerId, isLocal)
      for (const result of reply.results) await upsertRecords(db, result.records, result.sourceFile)
      const ack = reply.receipt
      if (reply.next) {
        request = { page: reply.next, ...(ack ? { ack } : {}) }
        continue
      }
      if (ack) await r.collect(computerId, { ack }).catch(() => undefined)
      break
    }
  }
}

// Records arrive attributed: the computer that ran them tags each with its task,
// by its session ledger, else by the worktree the session ran in (§9 Phase 7c —
// the hub keeps neither sessions nor task paths).

function dateRangeToSql(range: DateRange): string {
  switch (range) {
    case '7d':
      return "datetime('now', '-7 days')"
    case '30d':
      return "datetime('now', '-30 days')"
    case '90d':
      return "datetime('now', '-90 days')"
    case 'all':
      return "'1970-01-01'"
  }
}

/**
 * Which usage records a query may count. `null`: every record (a hub without login).
 * Otherwise only records of tasks in these projects — a record with no task has no
 * owner and is never counted (T-17: the projects come from the access scope).
 */
export type UsageScope = { readonly projectIds: readonly string[] } | null

/** `AND …` restricting `alias.task_id` to the scope, with its parameters. */
function scopeSql(scope: UsageScope, alias = ''): { sql: string; params: string[] } {
  if (!scope) return { sql: '', params: [] }
  if (scope.projectIds.length === 0) return { sql: ' AND 0', params: [] }
  const marks = scope.projectIds.map(() => '?').join(', ')
  return {
    sql: ` AND ${alias}task_id IN (SELECT id FROM tasks WHERE project_id IN (${marks}))`,
    params: [...scope.projectIds]
  }
}

/** Total tokens per day across all providers (no date filtering). */
export async function queryDailyTotals(
  db: SlayzoneDb,
  scope: UsageScope = null
): Promise<Array<{ date: string; totalTokens: number }>> {
  const s = scopeSql(scope)
  return (await db
    .prepare(
      `SELECT date(timestamp, 'localtime') as date,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as totalTokens
      FROM usage_records
      WHERE 1${s.sql}
      GROUP BY date(timestamp, 'localtime')
      ORDER BY date ASC`
    )
    .all(...s.params)) as Array<{ date: string; totalTokens: number }>
}

export async function queryAnalytics(
  db: SlayzoneDb,
  range: DateRange,
  scope: UsageScope = null
): Promise<AnalyticsSummary> {
  const since = dateRangeToSql(range)
  const s = scopeSql(scope)
  const ur = scopeSql(scope, 'ur.')

  const totals = (await db
    .prepare(
      `SELECT
        COALESCE(SUM(input_tokens), 0) as totalInputTokens,
        COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
        COALESCE(SUM(cache_read_tokens), 0) as totalCacheReadTokens,
        COALESCE(SUM(cache_write_tokens), 0) as totalCacheWriteTokens,
        COUNT(DISTINCT session_id) as totalSessions
      FROM usage_records
      WHERE timestamp >= ${since}${s.sql}`
    )
    .get(...s.params)) as {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheReadTokens: number
    totalCacheWriteTokens: number
    totalSessions: number
  }

  const totalInput = totals.totalInputTokens + totals.totalCacheWriteTokens
  const cacheHitPercent =
    totalInput > 0
      ? (totals.totalCacheReadTokens / (totalInput + totals.totalCacheReadTokens)) * 100
      : 0

  const byProvider = (await db
    .prepare(
      `SELECT provider,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as totalTokens,
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens,
        COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
        COALESCE(SUM(cache_write_tokens), 0) as cacheWriteTokens,
        COUNT(DISTINCT session_id) as sessions
      FROM usage_records WHERE timestamp >= ${since}${s.sql}
      GROUP BY provider ORDER BY totalTokens DESC`
    )
    .all(...s.params)) as Array<{
    provider: string
    totalTokens: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    sessions: number
  }>

  const byModel = (await db
    .prepare(
      `SELECT provider, model,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as totalTokens
      FROM usage_records WHERE timestamp >= ${since}${s.sql}
      GROUP BY provider, model ORDER BY totalTokens DESC`
    )
    .all(...s.params)) as Array<{ provider: string; model: string; totalTokens: number }>

  const byDay = (await db
    .prepare(
      `SELECT date(timestamp, 'localtime') as date, provider,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as totalTokens
      FROM usage_records WHERE timestamp >= ${since}${s.sql}
      GROUP BY date(timestamp, 'localtime'), provider ORDER BY date ASC`
    )
    .all(...s.params)) as Array<{ date: string; provider: string; totalTokens: number }>

  const byTask = (await db
    .prepare(
      `SELECT ur.provider, ur.task_id as taskId, COALESCE(t.title, 'Unknown') as taskTitle,
        SUM(ur.input_tokens + ur.output_tokens + ur.cache_read_tokens + ur.cache_write_tokens) as totalTokens
      FROM usage_records ur
      LEFT JOIN tasks t ON ur.task_id = t.id
      WHERE ur.timestamp >= ${since} AND ur.task_id IS NOT NULL${ur.sql}
      GROUP BY ur.provider, ur.task_id ORDER BY totalTokens DESC
      LIMIT 20`
    )
    .all(...ur.params)) as Array<{
    provider: string
    taskId: string
    taskTitle: string
    totalTokens: number
  }>

  return {
    ...totals,
    cacheHitPercent,
    byProvider,
    byModel,
    byDay,
    byTask
  }
}

export async function queryTaskCost(
  db: SlayzoneDb,
  taskId: string
): Promise<{
  totalTokens: number
  byProvider: Array<{ provider: string; model: string; totalTokens: number; sessions: number }>
}> {
  const byProvider = (await db
    .prepare(
      `SELECT provider, model,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as totalTokens,
        COUNT(DISTINCT session_id) as sessions
      FROM usage_records WHERE task_id = ?
      GROUP BY provider, model`
    )
    .all(taskId)) as Array<{
    provider: string
    model: string
    totalTokens: number
    sessions: number
  }>

  const totalTokens = byProvider.reduce((acc, r) => acc + r.totalTokens, 0)

  return { totalTokens, byProvider }
}
