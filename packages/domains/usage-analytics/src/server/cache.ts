import type Database from 'better-sqlite3'
import type { UsageRecord, AnalyticsSummary, DateRange } from '../shared/types'
import { parseClaudeFiles } from './parsers/claude'
import { parseCodexFiles } from './parsers/codex'
import { parseOpenCodeFiles } from './parsers/opencode'
import { parseQwenFiles } from './parsers/qwen'

interface ParseState {
  file_path: string
  last_offset: number
  last_modified_ms: number
}

function getLastOffset(
  db: Database.Database,
  filePath: string
): { offset: number; modifiedMs: number } | undefined {
  const row = db.prepare('SELECT last_offset, last_modified_ms FROM usage_parse_state WHERE file_path = ?').get(filePath) as
    | ParseState
    | undefined
  if (!row) return undefined
  return { offset: row.last_offset, modifiedMs: row.last_modified_ms }
}

function saveParseState(db: Database.Database, filePath: string, mtimeMs: number, endOffset: number): void {
  db.prepare(
    'INSERT OR REPLACE INTO usage_parse_state (file_path, last_modified_ms, last_offset) VALUES (?, ?, ?)'
  ).run(filePath, mtimeMs, endOffset)
}

function upsertRecords(db: Database.Database, records: UsageRecord[], sourceFile: string): number {
  if (records.length === 0) return 0

  const insert = db.prepare(`
    INSERT OR IGNORE INTO usage_records (
      id, provider, model, session_id, timestamp,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
      cost_usd, cwd, task_id, source_file, source_offset
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0)
  `)

  let inserted = 0
  const tx = db.transaction(() => {
    for (const r of records) {
      const result = insert.run(
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
      )
      inserted += result.changes
    }
  })
  tx()
  return inserted
}

export async function refreshUsageData(db: Database.Database): Promise<void> {
  const getOffset = (filePath: string) => getLastOffset(db, filePath)

  const allResults = await Promise.all([
    parseClaudeFiles(getOffset),
    parseCodexFiles(getOffset),
    parseOpenCodeFiles(getOffset),
    parseQwenFiles(getOffset)
  ])

  let totalInserted = 0
  for (const results of allResults) {
    for (const result of results) {
      const inserted = upsertRecords(db, result.records, result.sourceFile)
      saveParseState(db, result.sourceFile, result.fileMtimeMs, result.endOffset)
      totalInserted += inserted
    }
  }

  // Only correlate if new records were inserted
  if (totalInserted > 0) {
    correlateNewRecords(db)
  }
}

function correlateNewRecords(db: Database.Database): void {
  const tasks = db
    .prepare("SELECT id, provider_config, worktree_path FROM tasks WHERE provider_config IS NOT NULL AND provider_config != '{}'")
    .all() as Array<{ id: string; provider_config: string; worktree_path: string | null }>

  const updateBySession = db.prepare('UPDATE usage_records SET task_id = ? WHERE session_id = ? AND task_id IS NULL')

  for (const task of tasks) {
    let config: Record<string, { conversationId?: string }>
    try {
      config = JSON.parse(task.provider_config)
    } catch {
      continue
    }
    for (const mode of Object.values(config)) {
      if (mode.conversationId) {
        updateBySession.run(task.id, mode.conversationId)
      }
    }
  }

  const tasksWithPaths = db
    .prepare('SELECT id, worktree_path FROM tasks WHERE worktree_path IS NOT NULL')
    .all() as Array<{ id: string; worktree_path: string }>

  const updateByCwd = db.prepare('UPDATE usage_records SET task_id = ? WHERE cwd = ? AND task_id IS NULL')
  for (const task of tasksWithPaths) {
    updateByCwd.run(task.id, task.worktree_path)
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

/** Total tokens per day across all providers (no date filtering). */
export function queryDailyTotals(db: Database.Database): Array<{ date: string; totalTokens: number }> {
  return db
    .prepare(
      `SELECT date(timestamp, 'localtime') as date,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as totalTokens
      FROM usage_records
      GROUP BY date(timestamp, 'localtime')
      ORDER BY date ASC`
    )
    .all() as Array<{ date: string; totalTokens: number }>
}

export function queryAnalytics(db: Database.Database, range: DateRange): AnalyticsSummary {
  const since = dateRangeToSql(range)

  const totals = db
    .prepare(
      `SELECT
        COALESCE(SUM(input_tokens), 0) as totalInputTokens,
        COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
        COALESCE(SUM(cache_read_tokens), 0) as totalCacheReadTokens,
        COALESCE(SUM(cache_write_tokens), 0) as totalCacheWriteTokens,
        COUNT(DISTINCT session_id) as totalSessions
      FROM usage_records
      WHERE timestamp >= ${since}`
    )
    .get() as {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheReadTokens: number
    totalCacheWriteTokens: number
    totalSessions: number
  }

  const totalInput = totals.totalInputTokens + totals.totalCacheWriteTokens
  const cacheHitPercent = totalInput > 0 ? (totals.totalCacheReadTokens / (totalInput + totals.totalCacheReadTokens)) * 100 : 0

  const byProvider = db
    .prepare(
      `SELECT provider,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as totalTokens,
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens,
        COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
        COALESCE(SUM(cache_write_tokens), 0) as cacheWriteTokens,
        COUNT(DISTINCT session_id) as sessions
      FROM usage_records WHERE timestamp >= ${since}
      GROUP BY provider ORDER BY totalTokens DESC`
    )
    .all() as Array<{ provider: string; totalTokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; sessions: number }>

  const byModel = db
    .prepare(
      `SELECT provider, model,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as totalTokens
      FROM usage_records WHERE timestamp >= ${since}
      GROUP BY provider, model ORDER BY totalTokens DESC`
    )
    .all() as Array<{ provider: string; model: string; totalTokens: number }>

  const byDay = db
    .prepare(
      `SELECT date(timestamp, 'localtime') as date, provider,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as totalTokens
      FROM usage_records WHERE timestamp >= ${since}
      GROUP BY date(timestamp, 'localtime'), provider ORDER BY date ASC`
    )
    .all() as Array<{ date: string; provider: string; totalTokens: number }>

  const byTask = db
    .prepare(
      `SELECT ur.provider, ur.task_id as taskId, COALESCE(t.title, 'Unknown') as taskTitle,
        SUM(ur.input_tokens + ur.output_tokens + ur.cache_read_tokens + ur.cache_write_tokens) as totalTokens
      FROM usage_records ur
      LEFT JOIN tasks t ON ur.task_id = t.id
      WHERE ur.timestamp >= ${since} AND ur.task_id IS NOT NULL
      GROUP BY ur.provider, ur.task_id ORDER BY totalTokens DESC
      LIMIT 20`
    )
    .all() as Array<{ provider: string; taskId: string; taskTitle: string; totalTokens: number }>

  return {
    ...totals,
    cacheHitPercent,
    byProvider,
    byModel,
    byDay,
    byTask
  }
}

export function queryTaskCost(
  db: Database.Database,
  taskId: string
): { totalTokens: number; byProvider: Array<{ provider: string; model: string; totalTokens: number; sessions: number }> } {
  const byProvider = db
    .prepare(
      `SELECT provider, model,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as totalTokens,
        COUNT(DISTINCT session_id) as sessions
      FROM usage_records WHERE task_id = ?
      GROUP BY provider, model`
    )
    .all(taskId) as Array<{ provider: string; model: string; totalTokens: number; sessions: number }>

  const totalTokens = byProvider.reduce((acc, r) => acc + r.totalTokens, 0)

  return { totalTokens, byProvider }
}
