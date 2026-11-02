import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { SlayzoneDb } from '@slayzone/platform'
import type { ChatRecord } from '@slayzone/chat-runtime/shared'
const PRIVATE = "(event LIKE 'chat.%' OR event LIKE 'renderer.chat.%' OR event='pty.hook_received')"

/** Old diagnostic payloads follow verified chat cutover. Event names/times stay on hub. */
export function createLegacyChatDiagnostics(opts: { db: SlayzoneDb; blobDir?: string }) {
  const { db } = opts
  let ready: Promise<void> | null = null
  const init = () =>
    (ready ??=
      db.exec(`CREATE TABLE IF NOT EXISTS chat_content_locks(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,cutoff INTEGER NOT NULL,blobs TEXT NOT NULL DEFAULT '[]');
 CREATE TRIGGER IF NOT EXISTS chat_diagnostic_delete BEFORE DELETE ON diagnostics_events WHEN ${PRIVATE.replaceAll('event', 'OLD.event')} AND EXISTS(SELECT 1 FROM chat_content_locks WHERE task_id=OLD.task_id AND state='copying') BEGIN SELECT RAISE(ABORT,'Chat diagnostic migration is in progress'); END;
 CREATE TRIGGER IF NOT EXISTS chat_diagnostic_update BEFORE UPDATE ON diagnostics_events WHEN ${PRIVATE.replaceAll('event', 'OLD.event')} AND EXISTS(SELECT 1 FROM chat_content_locks WHERE task_id=OLD.task_id AND state='copying') BEGIN SELECT RAISE(ABORT,'Chat diagnostic migration is in progress'); END;`))
  function files(payload: unknown): string[] {
    if (!payload || typeof payload !== 'object') return []
    const result: string[] = []
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'screenshotDataUrl' && typeof value === 'string' && opts.blobDir) {
        const path = resolve(value)
        if (
          path.startsWith(resolve(opts.blobDir) + sep) &&
          existsSync(path) &&
          lstatSync(path).isFile() &&
          !lstatSync(path).isSymbolicLink()
        )
          result.push(path)
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
        `INSERT INTO chat_content_locks(task_id,state,cutoff) SELECT ?,'copying',COALESCE(MAX(rowid),0) FROM diagnostics_events WHERE task_id=? AND ${PRIVATE} ON CONFLICT(task_id) DO NOTHING`,
        [taskId, taskId]
      )
      return (await db.get<{ cutoff: number }>(
        'SELECT cutoff FROM chat_content_locks WHERE task_id=?',
        [taskId]
      ))!.cutoff
    },
    async *records(taskId: string, cutoff: number): AsyncGenerator<ChatRecord> {
      let after = 0
      for (;;) {
        const rows = await db.all<
          Record<string, unknown> & {
            rowid: number
            id: string
            ts_ms: number
            payload_json: string | null
          }
        >(
          `SELECT rowid,* FROM diagnostics_events WHERE task_id=? AND rowid>? AND rowid<=? AND ${PRIVATE} ORDER BY rowid LIMIT 256`,
          [taskId, after, cutoff]
        )
        if (!rows.length) return
        for (const { rowid, ...row } of rows) {
          after = rowid
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
          `SELECT payload_json FROM diagnostics_events WHERE task_id=? AND rowid<=? AND ${PRIVATE}`,
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
          sql: `UPDATE diagnostics_events SET message='',payload_json=NULL WHERE task_id=? AND rowid<=? AND ${PRIVATE}`,
          params: [taskId, cutoff]
        }
      ])
      for (const path of paths)
        if (
          opts.blobDir &&
          resolve(path).startsWith(resolve(opts.blobDir) + sep) &&
          existsSync(path)
        )
          unlinkSync(path)
      await db.run("UPDATE chat_content_locks SET state='cleaned',blobs='[]' WHERE task_id=?", [
        taskId
      ])
      const checkpoint = await db.get<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)')
      if (checkpoint?.busy) throw new Error('Diagnostic cleanup checkpoint is busy')
    }
  }
}
