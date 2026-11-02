import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { SlayzoneDb } from '@slayzone/platform'
import type { ChatRecord } from '@slayzone/chat-runtime/shared'
const PRIVATE_EVENT =
  "(event LIKE 'chat.%' OR event LIKE 'renderer.chat.%' OR event='pty.hook_received')"
function privateRows(alias = ''): string {
  return `${alias ? `${alias}.` : ''}id IN(SELECT event_id FROM chat_legacy_diagnostics)`
}
const PRIVATE = privateRows()

/** Old diagnostic payloads follow verified chat cutover. Event names/times stay on hub. */
export function createLegacyChatDiagnostics(opts: { db: SlayzoneDb; blobDir?: string }) {
  const { db } = opts
  const boundaryMs = Date.now()
  let ready: Promise<void> | null = null
  const init = () =>
    (ready ??= (async () => {
      await db.exec(`CREATE TABLE IF NOT EXISTS chat_privacy_boundary(id INTEGER PRIMARY KEY CHECK(id=1),cutoff_ms INTEGER NOT NULL,cleanup_generation INTEGER NOT NULL DEFAULT 1,compacted_generation INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS chat_legacy_diagnostics(ordinal INTEGER PRIMARY KEY,event_id TEXT NOT NULL UNIQUE,task_id TEXT);
CREATE INDEX IF NOT EXISTS chat_legacy_diagnostics_task ON chat_legacy_diagnostics(task_id,ordinal);
CREATE TABLE IF NOT EXISTS chat_content_locks(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,cutoff INTEGER NOT NULL,blobs TEXT NOT NULL DEFAULT '[]');`)
      // Capture IDs atomically once. VACUUM and retention can renumber/reuse rowids.
      await db.batchTxn([
        {
          type: 'run',
          sql: `INSERT INTO chat_legacy_diagnostics(ordinal,event_id,task_id) SELECT rowid,id,task_id FROM diagnostics_events WHERE ${PRIVATE_EVENT} AND NOT EXISTS(SELECT 1 FROM chat_privacy_boundary WHERE id=1)`,
          params: []
        },
        {
          type: 'run',
          sql: 'INSERT INTO chat_privacy_boundary(id,cutoff_ms) VALUES(1,?) ON CONFLICT(id) DO NOTHING',
          params: [boundaryMs]
        }
      ])
      await db.exec(`CREATE TRIGGER IF NOT EXISTS chat_diagnostic_delete BEFORE DELETE ON diagnostics_events WHEN ${privateRows('OLD')} AND EXISTS(SELECT 1 FROM chat_content_locks WHERE task_id=OLD.task_id AND state='copying') BEGIN SELECT RAISE(ABORT,'Chat diagnostic migration is in progress'); END;
CREATE TRIGGER IF NOT EXISTS chat_diagnostic_update BEFORE UPDATE ON diagnostics_events WHEN ${privateRows('OLD')} AND EXISTS(SELECT 1 FROM chat_content_locks WHERE task_id=OLD.task_id AND state='copying') BEGIN SELECT RAISE(ABORT,'Chat diagnostic migration is in progress'); END;`)
    })())
  function safeBlob(path: string): boolean {
    if (!opts.blobDir || !existsSync(path) || !existsSync(opts.blobDir)) return false
    return (
      realpathSync(path).startsWith(realpathSync(opts.blobDir) + sep) &&
      lstatSync(path).isFile() &&
      !lstatSync(path).isSymbolicLink()
    )
  }
  function files(payload: unknown): string[] {
    if (!payload || typeof payload !== 'object') return []
    const result: string[] = []
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'screenshotDataUrl' && typeof value === 'string' && opts.blobDir) {
        const path = resolve(value)
        if (path.startsWith(resolve(opts.blobDir) + sep) && safeBlob(path)) result.push(path)
      } else if (value && typeof value === 'object') result.push(...files(value))
    }
    return result
  }
  function inline(payload: unknown): unknown {
    if (!payload || typeof payload !== 'object') return payload
    if (Array.isArray(payload)) return payload.map(inline)
    return Object.fromEntries(
      Object.entries(payload).map(([key, value]) => {
        if (
          key === 'screenshotDataUrl' &&
          typeof value === 'string' &&
          files({ [key]: value }).length
        ) {
          const mime = value.endsWith('.jpg')
            ? 'image/jpeg'
            : value.endsWith('.webp')
              ? 'image/webp'
              : 'image/png'
          return [key, `data:${mime};base64,${readFileSync(value).toString('base64')}`]
        }
        return [key, inline(value)]
      })
    )
  }
  return {
    initialize: init,
    async compact() {
      await init()
      const state = await db.get<{ cleanup_generation: number; compacted_generation: number }>(
        'SELECT cleanup_generation,compacted_generation FROM chat_privacy_boundary WHERE id=1'
      )
      if (!state || state.cleanup_generation === state.compacted_generation) return
      await db.exec('PRAGMA secure_delete=ON')
      await db.exec('VACUUM')
      const checkpoint = await db.get<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)')
      if (checkpoint?.busy) throw new Error('Diagnostic privacy checkpoint is busy')
      await db.run('UPDATE chat_privacy_boundary SET compacted_generation=? WHERE id=1', [
        state.cleanup_generation
      ])
    },
    async hasTask(taskId: string) {
      await init()
      return !!(await db.get(
        `SELECT 1 FROM diagnostics_events d WHERE task_id=? AND ${PRIVATE} AND NOT EXISTS(SELECT 1 FROM chat_content_locks l WHERE l.task_id=d.task_id AND l.state='cleaned') LIMIT 1`,
        [taskId]
      ))
    },
    async tasks() {
      await init()
      return (
        await db.all<{ task_id: string }>(
          `SELECT DISTINCT task_id FROM diagnostics_events d WHERE task_id IS NOT NULL AND ${PRIVATE} AND NOT EXISTS(SELECT 1 FROM chat_content_locks l WHERE l.task_id=d.task_id AND l.state='cleaned')`
        )
      ).map((r) => r.task_id)
    },
    async freeze(taskId: string) {
      await init()
      await db.run(
        `INSERT INTO chat_content_locks(task_id,state,cutoff) SELECT ?,'copying',COALESCE(MAX(ordinal),0) FROM chat_legacy_diagnostics WHERE task_id=? ON CONFLICT(task_id) DO NOTHING`,
        [taskId, taskId]
      )
      return (await db.get<{ cutoff: number }>(
        'SELECT cutoff FROM chat_content_locks WHERE task_id=?',
        [taskId]
      ))!.cutoff
    },
    async *records(taskId: string, cutoff: number): AsyncGenerator<ChatRecord> {
      await init()
      let after = 0
      for (;;) {
        const rows = await db.all<
          Record<string, unknown> & {
            source_ordinal: number
            id: string
            ts_ms: number
            payload_json: string | null
          }
        >(
          `SELECT l.ordinal AS source_ordinal,d.* FROM diagnostics_events d JOIN chat_legacy_diagnostics l ON l.event_id=d.id WHERE d.task_id=? AND l.ordinal>? AND l.ordinal<=? ORDER BY l.ordinal LIMIT 256`,
          [taskId, after, cutoff]
        )
        if (!rows.length) return
        for (const { source_ordinal, ...row } of rows) {
          after = source_ordinal
          let value = row
          if (row.payload_json) {
            try {
              value = { ...row, payload_json: JSON.stringify(inline(JSON.parse(row.payload_json))) }
            } catch {}
          }
          yield { kind: 'settings', id: `diagnostic:${row.id}`, value, at: row.ts_ms }
        }
      }
    },
    async cleanup(taskId: string, cutoff: number) {
      await init()
      await db.exec('PRAGMA secure_delete=ON')
      const rows = await db.all<{ payload_json: string | null }>(
          `SELECT payload_json FROM diagnostics_events WHERE task_id=? AND id IN(SELECT event_id FROM chat_legacy_diagnostics WHERE ordinal<=?)`,
          [taskId, cutoff]
        ),
        paths = new Set<string>()
      for (const row of rows)
        if (row.payload_json) {
          try {
            for (const file of files(JSON.parse(row.payload_json))) paths.add(file)
          } catch {}
        }
      const prior = await db.get<{ blobs: string }>(
        'SELECT blobs FROM chat_content_locks WHERE task_id=?',
        [taskId]
      )
      for (const path of JSON.parse(prior?.blobs ?? '[]') as string[]) paths.add(path)
      await db.batchTxn([
        {
          type: 'run',
          sql: "INSERT INTO chat_content_locks(task_id,state,cutoff,blobs) VALUES(?,'cleaning',?,?) ON CONFLICT(task_id) DO UPDATE SET state='cleaning',blobs=excluded.blobs",
          params: [taskId, cutoff, JSON.stringify([...paths])]
        },
        {
          type: 'run',
          sql: `UPDATE diagnostics_events SET message='',payload_json=NULL WHERE task_id=? AND id IN(SELECT event_id FROM chat_legacy_diagnostics WHERE ordinal<=?)`,
          params: [taskId, cutoff]
        },
        {
          type: 'run',
          sql: 'UPDATE chat_privacy_boundary SET cleanup_generation=cleanup_generation+1 WHERE id=1',
          params: []
        }
      ])
      for (const path of paths) if (safeBlob(path)) unlinkSync(path)
      await db.run("UPDATE chat_content_locks SET state='cleaned',blobs='[]' WHERE task_id=?", [
        taskId
      ])
      const checkpoint = await db.get<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)')
      if (checkpoint?.busy) throw new Error('Diagnostic cleanup checkpoint is busy')
    }
  }
}
