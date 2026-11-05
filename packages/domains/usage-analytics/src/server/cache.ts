import type { SlayzoneDb } from '@slayzone/platform'
import type { UsageRecord, AnalyticsSummary, DateRange } from '../shared/types'
import { collectUsage, type ParseResult, type UsageCursors } from './collect'

interface ParseState {
  file_path: string
  last_offset: number
  last_modified_ms: number
}

/** The hub's own disk, in `usage_parse_state.computer_id`. */
const HUB_DISK = ''

/**
 * Where usage logs are parsed: on each connected computer (`usage.collect`), wired
 * by the hub's composition. Unwired: the hub parses its own disk, as before.
 */
/** Where a paged collect continues (`usage.collect` `next`). */
export interface UsageCollectPage {
  token: string
  index: number
}

/** One page of a collect: `complete: false` = more of that file follows. */
export interface UsageCollectReply {
  results: Array<ParseResult & { complete?: boolean }>
  next?: UsageCollectPage
}

export interface UsageCollectRouting {
  /** The computers to ask this refresh (connected ones). */
  computers(): readonly string[]
  /** One page: the first (from `cursors`), or the one `page` names. */
  collect(
    computerId: string,
    cursors: UsageCursors,
    page?: UsageCollectPage
  ): Promise<UsageCollectReply>
  /**
   * The computer on this hub's own machine (the desktop's local computer): it reads
   * the files the hub's old cursors (computer_id '') point into, so it takes them
   * over instead of re-parsing every log.
   */
  localComputerId?(): string | null
}

let routing: UsageCollectRouting | null = null

export function setUsageCollectRouting(next: UsageCollectRouting | null): void {
  routing = next
}

/**
 * Load all incremental-parse offsets up front into a Map. The file parsers take
 * a SYNCHRONOUS `getOffset(filePath)` callback (they call it inline while
 * walking files), so we can't hand them an async DB lookup. One query + a Map
 * is both contract-correct and cheaper than a per-file round-trip to the worker.
 */
async function loadCursors(db: SlayzoneDb, computerId: string): Promise<UsageCursors> {
  const rows = (await db.all(
    'SELECT file_path, last_offset, last_modified_ms FROM usage_parse_state WHERE computer_id = ?',
    [computerId]
  )) as ParseState[]
  const out: UsageCursors = {}
  for (const r of rows) out[r.file_path] = { offset: r.last_offset, modifiedMs: r.last_modified_ms }
  return out
}

/**
 * Hand the hub's own cursors (computer_id '', what v194 kept from the hub-disk
 * parse) to the computer on the hub's machine, once: moved, not copied, so they are
 * never adopted twice. A cursor the computer already has wins.
 */
async function adoptHubDiskCursors(db: SlayzoneDb, computerId: string): Promise<void> {
  await db.batchTxn([
    {
      type: 'run' as const,
      sql: `INSERT OR IGNORE INTO usage_parse_state (computer_id, file_path, last_offset, last_modified_ms)
        SELECT ?, file_path, last_offset, last_modified_ms FROM usage_parse_state WHERE computer_id = ?`,
      params: [computerId, HUB_DISK]
    },
    {
      type: 'run' as const,
      sql: 'DELETE FROM usage_parse_state WHERE computer_id = ?',
      params: [HUB_DISK]
    }
  ])
}

async function saveParseState(
  db: SlayzoneDb,
  computerId: string,
  filePath: string,
  mtimeMs: number,
  endOffset: number
): Promise<void> {
  await db
    .prepare(
      'INSERT OR REPLACE INTO usage_parse_state (computer_id, file_path, last_modified_ms, last_offset) VALUES (?, ?, ?, ?)'
    )
    .run(computerId, filePath, mtimeMs, endOffset)
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
  // Each computer parses its own logs; the hub's disk only without routing (on the
  // desktop the local computer reads the very same logs).
  const sources: Array<{
    computerId: string
    collect: (c: UsageCursors, page?: UsageCollectPage) => Promise<UsageCollectReply>
  }> = routing
    ? routing.computers().map((id) => ({
        computerId: id,
        collect: (c, page) => (routing as UsageCollectRouting).collect(id, c, page)
      }))
    : [{ computerId: HUB_DISK, collect: async (c) => ({ results: await collectUsage(c) }) }]

  const local = routing?.localComputerId?.() ?? null
  if (local && sources.some((source) => source.computerId === local)) {
    await adoptHubDiskCursors(db, local)
  }

  let totalInserted = 0
  for (const source of sources) {
    const cursors = await loadCursors(db, source.computerId)
    let page: UsageCollectPage | undefined
    // Page by page: each page is stored (records, and the cursors of files it
    // completes) before the next is asked for, so a lost page loses nothing earlier.
    do {
      let reply: UsageCollectReply
      try {
        reply = await source.collect(cursors, page)
      } catch {
        break // unreachable now: its saved cursors stand, the next refresh resumes
      }
      for (const result of reply.results) {
        totalInserted += await upsertRecords(db, result.records, result.sourceFile)
        // A file split across pages: its cursor moves only with its last chunk.
        if (result.complete === false) continue
        await saveParseState(
          db,
          source.computerId,
          result.sourceFile,
          result.fileMtimeMs,
          result.endOffset
        )
      }
      page = reply.next
    } while (page)
  }

  // Only correlate if new records were inserted
  if (totalInserted > 0) {
    await correlateNewRecords(db)
  }
}

async function correlateNewRecords(db: SlayzoneDb): Promise<void> {
  const tasks = (await db
    .prepare(
      "SELECT id, provider_config, worktree_path FROM tasks WHERE provider_config IS NOT NULL AND provider_config != '{}'"
    )
    .all()) as Array<{ id: string; provider_config: string; worktree_path: string | null }>

  const updateBySession = db.prepare(
    'UPDATE usage_records SET task_id = ? WHERE session_id = ? AND task_id IS NULL'
  )

  for (const task of tasks) {
    let config: Record<string, { conversationId?: string }>
    try {
      config = JSON.parse(task.provider_config)
    } catch {
      continue
    }
    for (const mode of Object.values(config)) {
      if (mode.conversationId) {
        await updateBySession.run(task.id, mode.conversationId)
      }
    }
  }

  const tasksWithPaths = (await db
    .prepare('SELECT id, worktree_path FROM tasks WHERE worktree_path IS NOT NULL')
    .all()) as Array<{ id: string; worktree_path: string }>

  const updateByCwd = db.prepare(
    'UPDATE usage_records SET task_id = ? WHERE cwd = ? AND task_id IS NULL'
  )
  for (const task of tasksWithPaths) {
    await updateByCwd.run(task.id, task.worktree_path)
  }
}

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
