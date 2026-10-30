import type { SlayzoneDb } from '@slayzone/platform'

/**
 * Storage of the hub's timeline projection (`chat_timeline_checkpoints`,
 * `chat_timeline_pages`, migration 179) — DERIVED from `chat_events`, safe to
 * throw away: the projection rebuilds it whenever it is missing, of another
 * version, or unreadable. Text in, text out: (de)coding is the projection's.
 */

export interface TimelineCheckpointRow {
  version: string
  /** The newest saved event folded in. */
  seq: number
  data: string
}

export interface TimelinePageRow {
  page: number
  startRow: number
  endRow: number
  rows: string
  summary: string
  /** Lowercased (`pageSearchText`). */
  searchText: string
}

export interface TimelineWrite {
  /** Delete every page from this one on first (rows moved: `null` = keep them). */
  dropPagesFrom: number | null
  pages: TimelinePageRow[]
  /**
   * `null`: pages written along a long run, ahead of any checkpoint — the stored
   * one is deleted (the next open rebuilds unless a later write stores one).
   */
  checkpoint: TimelineCheckpointRow | null
}

export async function loadTimelineCheckpoint(
  db: SlayzoneDb,
  tabId: string
): Promise<TimelineCheckpointRow | null> {
  const row = await db
    .prepare('SELECT version, seq, data FROM chat_timeline_checkpoints WHERE tab_id = ?')
    .get<TimelineCheckpointRow>(tabId)
  return row ?? null
}

export async function loadTimelinePages(
  db: SlayzoneDb,
  tabId: string,
  pages: readonly number[]
): Promise<Array<{ page: number; rows: string }>> {
  if (pages.length === 0) return []
  const marks = pages.map(() => '?').join(', ')
  return db
    .prepare(`SELECT page, rows FROM chat_timeline_pages WHERE tab_id = ? AND page IN (${marks})`)
    .all<{ page: number; rows: string }>(tabId, ...pages)
}

export async function loadTimelineSummaries(
  db: SlayzoneDb,
  tabId: string
): Promise<Array<{ page: number; summary: string }>> {
  return db
    .prepare('SELECT page, summary FROM chat_timeline_pages WHERE tab_id = ? ORDER BY page ASC')
    .all<{ page: number; summary: string }>(tabId)
}

/** Pages, then the checkpoint that names them — one transaction. */
export async function saveTimeline(
  db: SlayzoneDb,
  tabId: string,
  write: TimelineWrite
): Promise<void> {
  const ops: Parameters<SlayzoneDb['batchTxn']>[0] = []
  if (write.dropPagesFrom !== null) {
    ops.push({
      type: 'run',
      sql: 'DELETE FROM chat_timeline_pages WHERE tab_id = ? AND page >= ?',
      params: [tabId, write.dropPagesFrom]
    })
  }
  for (const p of write.pages) {
    ops.push({
      type: 'run',
      sql:
        'INSERT INTO chat_timeline_pages (tab_id, page, start_row, end_row, rows, summary, search_text) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tab_id, page) DO UPDATE SET ' +
        'start_row = excluded.start_row, end_row = excluded.end_row, rows = excluded.rows, ' +
        'summary = excluded.summary, search_text = excluded.search_text',
      params: [tabId, p.page, p.startRow, p.endRow, p.rows, p.summary, p.searchText]
    })
  }
  ops.push(
    write.checkpoint === null
      ? {
          type: 'run',
          sql: 'DELETE FROM chat_timeline_checkpoints WHERE tab_id = ?',
          params: [tabId]
        }
      : {
          type: 'run',
          sql:
            'INSERT INTO chat_timeline_checkpoints (tab_id, version, seq, data, updated_at) VALUES (?, ?, ?, ?, ?) ' +
            'ON CONFLICT(tab_id) DO UPDATE SET version = excluded.version, seq = excluded.seq, ' +
            'data = excluded.data, updated_at = excluded.updated_at',
          params: [
            tabId,
            write.checkpoint.version,
            write.checkpoint.seq,
            write.checkpoint.data,
            Date.now()
          ]
        }
  )
  await db.batchTxn(ops)
}

/** Pages whose (lowercased) search text holds `needleLower`, ascending. */
export async function searchTimelinePages(
  db: SlayzoneDb,
  tabId: string,
  needleLower: string
): Promise<number[]> {
  const rows = await db
    .prepare(
      'SELECT page FROM chat_timeline_pages WHERE tab_id = ? AND instr(search_text, ?) > 0 ORDER BY page ASC'
    )
    .all<{ page: number }>(tabId, needleLower)
  return rows.map((r) => r.page)
}

export async function clearTimeline(db: SlayzoneDb, tabId: string): Promise<void> {
  await db.batchTxn([
    { type: 'run', sql: 'DELETE FROM chat_timeline_pages WHERE tab_id = ?', params: [tabId] },
    { type: 'run', sql: 'DELETE FROM chat_timeline_checkpoints WHERE tab_id = ?', params: [tabId] }
  ])
}
