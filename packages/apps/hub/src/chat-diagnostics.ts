import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { BatchOp, SlayzoneDb } from '@slayzone/platform'
import type { ChatRecord } from '@slayzone/chat-runtime/shared'
const PRIVATE_EVENT =
  "(event LIKE 'chat.%' OR event LIKE 'renderer.chat.%' OR event IN ('renderer.error-boundary','renderer.window.error','renderer.window.unhandledrejection','main.uncaught_exception','main.unhandled_rejection','pty.hook_received') OR payload_json LIKE '%screenshotDataUrl%')"

export interface DiagnosticTaskEvidence {
  taskIds: string[]
  tabIds: string[]
  sessionIds: string[]
}

/** Resolve only exact ledger IDs; conflicting or unknown explicit tasks stay pending. */
export function createDiagnosticTaskResolver(db: SlayzoneDb) {
  return async (evidence: DiagnosticTaskEvidence): Promise<string | null> => {
    const tasks = new Set<string>()
    for (const id of evidence.taskIds) {
      if (
        !(await db.get(
          "SELECT 1 FROM tasks WHERE id=? UNION SELECT 1 FROM chat_task_lifecycle WHERE task_id=? AND state='deleted' LIMIT 1",
          [id, id]
        ))
      )
        return null
      tasks.add(id)
    }
    for (const id of evidence.tabIds)
      for (const row of await db.all<{ task_id: string }>(
        'SELECT task_id FROM terminal_tabs WHERE id=?',
        [id]
      ))
        tasks.add(row.task_id)
    for (const id of evidence.sessionIds)
      for (const row of await db.all<{ task_id: string }>(
        'SELECT DISTINCT task_id FROM agent_sessions WHERE (id=? OR conversation_id=?) AND task_id IS NOT NULL',
        [id, id]
      ))
        tasks.add(row.task_id)
    return tasks.size === 1 ? [...tasks][0] : null
  }
}

function taskEvidence(row: {
  task_id: string | null
  session_id?: string | null
  payload_json: string | null
}): DiagnosticTaskEvidence {
  const tasks = new Set<string>(),
    tabs = new Set<string>(),
    sessions = new Set<string>()
  if (row.task_id) tasks.add(row.task_id)
  if (row.session_id) sessions.add(row.session_id)
  function visit(value: unknown, depth = 0) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && item.length <= 200) {
        if (['taskId', 'task_id', 'activeTaskId'].includes(key)) tasks.add(item)
        if (['tabId', 'tab_id'].includes(key)) tabs.add(item)
        if (['sessionId', 'session_id'].includes(key)) sessions.add(item)
      } else if (['context', 'snapshot', 'chat', 'session'].includes(key)) visit(item, depth + 1)
    }
  }
  try {
    visit(JSON.parse(row.payload_json ?? 'null'))
  } catch {
    /* Malformed legacy content remains readable. */
  }
  return { taskIds: [...tasks], tabIds: [...tabs], sessionIds: [...sessions] }
}

/** Old diagnostic payloads follow verified chat cutover. Event names/times stay on hub. */
export function createLegacyChatDiagnostics(opts: {
  db: SlayzoneDb
  blobDir?: string
  resolveTask?(evidence: DiagnosticTaskEvidence): Promise<string | null>
}) {
  const { db } = opts
  const boundaryMs = Date.now()
  let ready: Promise<void> | null = null
  const init = () =>
    (ready ??= (async () => {
      await db.exec(`CREATE TABLE IF NOT EXISTS chat_privacy_boundary(id INTEGER PRIMARY KEY CHECK(id=1),cutoff_ms INTEGER NOT NULL,cleanup_generation INTEGER NOT NULL DEFAULT 1,compacted_generation INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS chat_legacy_diagnostics(ordinal INTEGER PRIMARY KEY,event_id TEXT NOT NULL UNIQUE,task_id TEXT);
CREATE TABLE IF NOT EXISTS diagnostic_content_holds(event_id TEXT PRIMARY KEY,blob_paths TEXT NOT NULL DEFAULT '[]');
CREATE INDEX IF NOT EXISTS chat_legacy_diagnostics_task ON chat_legacy_diagnostics(task_id,ordinal);
CREATE TABLE IF NOT EXISTS chat_content_locks(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,cutoff INTEGER NOT NULL,blobs TEXT NOT NULL DEFAULT '[]');`)
      // Capture IDs atomically once. VACUUM and retention can renumber/reuse rowids.
      const columns = await db.all<{ name: string }>('PRAGMA table_info(diagnostics_events)')
      const privateEvent = columns.some((column) => column.name === 'channel')
        ? `(${PRIVATE_EVENT} OR channel LIKE 'chat:%' OR channel LIKE 'chat.%')`
        : PRIVATE_EVENT
      await db.batchTxn([
        {
          type: 'run',
          sql: `INSERT INTO chat_legacy_diagnostics(ordinal,event_id,task_id) SELECT rowid,id,NULL FROM diagnostics_events WHERE ${privateEvent} AND NOT EXISTS(SELECT 1 FROM chat_privacy_boundary WHERE id=1)`,
          params: []
        },
        {
          type: 'run',
          sql: "INSERT INTO diagnostic_content_holds(event_id,blob_paths) SELECT l.event_id,'null' FROM chat_legacy_diagnostics l JOIN diagnostics_events d ON d.id=l.event_id WHERE NOT EXISTS(SELECT 1 FROM chat_content_locks c WHERE c.task_id=l.task_id AND c.state='cleaned') ON CONFLICT(event_id) DO NOTHING",
          params: []
        },
        {
          type: 'run',
          sql: 'INSERT INTO chat_privacy_boundary(id,cutoff_ms) VALUES(1,?) ON CONFLICT(id) DO NOTHING',
          params: [boundaryMs]
        }
      ])
      const pending =
        "EXISTS(SELECT 1 FROM chat_legacy_diagnostics l WHERE l.event_id=OLD.id AND NOT EXISTS(SELECT 1 FROM chat_content_locks c WHERE c.task_id=l.task_id AND c.state IN ('cleaning','cleaned')))"
      await db.exec(`CREATE TRIGGER IF NOT EXISTS chat_diagnostic_delete_pending BEFORE DELETE ON diagnostics_events WHEN ${pending} BEGIN SELECT RAISE(ABORT,'Chat diagnostic migration is pending'); END;
CREATE TRIGGER IF NOT EXISTS chat_diagnostic_update_pending BEFORE UPDATE ON diagnostics_events WHEN ${pending} BEGIN SELECT RAISE(ABORT,'Chat diagnostic migration is pending'); END;`)
    })())
  // ONE attribution pass per process. Every relay lookup (hasTask/tasks/freeze)
  // awaits it, and rows whose owner cannot be resolved stay pending forever — so
  // a pass that reset on completion re-walked every such row on every lookup, a
  // long block on the hub thread per call (it froze the hub for most of a minute
  // after a renderer reload and timed out every task tab). The ledger only grows
  // inside `init()`, so nothing new can need attributing until the next process,
  // which gets its own fresh attempt. A FAILED pass is forgotten so the next
  // caller retries it.
  let attributed: Promise<void> | null = null
  async function initialize() {
    await init()
    attributed ??= attribute().catch((err: unknown) => {
      attributed = null
      throw err
    })
    return attributed
  }
  async function attribute() {
    let after = 0
    for (;;) {
      // Let queued requests run between batches: the rest of the hub must not
      // wait for a whole legacy pass.
      await new Promise<void>((resolve) => setImmediate(resolve))
      const rows = await db.all<{
        source_ordinal: number
        ledger_task_id: string | null
        id: string
        task_id: string | null
        session_id?: string | null
        payload_json: string | null
      }>(
        "SELECT l.ordinal AS source_ordinal,l.task_id AS ledger_task_id,d.* FROM chat_legacy_diagnostics l JOIN diagnostics_events d ON d.id=l.event_id JOIN diagnostic_content_holds h ON h.event_id=d.id WHERE (l.task_id IS NULL OR h.blob_paths='null') AND l.ordinal>? ORDER BY l.ordinal LIMIT 256",
        [after]
      )
      if (!rows.length) break
      // One write transaction per batch instead of one or two per row.
      const writes: BatchOp[] = []
      for (const row of rows) {
        after = row.source_ordinal
        let paths: string[] = []
        try {
          paths = files(JSON.parse(row.payload_json ?? 'null'))
        } catch {
          /* Keep the raw record even when legacy JSON is malformed. */
        }
        writes.push({
          type: 'run',
          sql: 'INSERT INTO diagnostic_content_holds(event_id,blob_paths) VALUES(?,?) ON CONFLICT(event_id) DO UPDATE SET blob_paths=excluded.blob_paths',
          params: [row.id, JSON.stringify(paths)]
        })
        if (row.ledger_task_id) continue
        const evidence = taskEvidence(row),
          taskId = opts.resolveTask
            ? await opts.resolveTask(evidence)
            : evidence.taskIds.length === 1
              ? evidence.taskIds[0]
              : null
        if (taskId)
          writes.push({
            type: 'run',
            sql: 'UPDATE chat_legacy_diagnostics SET task_id=? WHERE event_id=? AND task_id IS NULL',
            params: [taskId, row.id]
          })
      }
      await db.batchTxn(writes)
    }
  }
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
    initialize,
    async unassigned() {
      await initialize()
      return (
        (
          await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM chat_legacy_diagnostics l JOIN diagnostics_events d ON d.id=l.event_id WHERE l.task_id IS NULL'
          )
        )?.n ?? 0
      )
    },
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
      await initialize()
      return !!(await db.get(
        `SELECT 1 FROM diagnostics_events d JOIN chat_legacy_diagnostics l ON l.event_id=d.id WHERE l.task_id=? AND NOT EXISTS(SELECT 1 FROM chat_content_locks c WHERE c.task_id=l.task_id AND c.state='cleaned') LIMIT 1`,
        [taskId]
      ))
    },
    async tasks() {
      await initialize()
      return (
        await db.all<{ task_id: string }>(
          `SELECT DISTINCT l.task_id FROM diagnostics_events d JOIN chat_legacy_diagnostics l ON l.event_id=d.id WHERE l.task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM chat_content_locks c WHERE c.task_id=l.task_id AND c.state='cleaned') ORDER BY l.task_id`
        )
      ).map((r) => r.task_id)
    },
    async freeze(taskId: string) {
      await initialize()
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
          `SELECT l.ordinal AS source_ordinal,d.* FROM diagnostics_events d JOIN chat_legacy_diagnostics l ON l.event_id=d.id WHERE l.task_id=? AND l.ordinal>? AND l.ordinal<=? ORDER BY l.ordinal LIMIT 256`,
          [taskId, after, cutoff]
        )
        if (!rows.length) return
        for (const { source_ordinal, ...row } of rows) {
          after = source_ordinal
          let value = row
          if (row.payload_json) {
            try {
              value = { ...row, payload_json: JSON.stringify(inline(JSON.parse(row.payload_json))) }
            } catch {
              // Preserve malformed legacy JSON verbatim in the verified copy.
            }
          }
          yield { kind: 'settings', id: `diagnostic:${row.id}`, value, at: row.ts_ms }
        }
      }
    },
    async cleanup(taskId: string, cutoff: number) {
      await init()
      await db.exec('PRAGMA secure_delete=ON')
      const rows = await db.all<{ payload_json: string | null }>(
          `SELECT payload_json FROM diagnostics_events WHERE id IN(SELECT event_id FROM chat_legacy_diagnostics WHERE task_id=? AND ordinal<=?)`,
          [taskId, cutoff]
        ),
        paths = new Set<string>()
      for (const row of rows)
        if (row.payload_json) {
          try {
            for (const file of files(JSON.parse(row.payload_json))) paths.add(file)
          } catch {
            // Malformed JSON has no safely attributable screenshot paths.
          }
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
          sql: `UPDATE diagnostics_events SET message='',payload_json=NULL WHERE id IN(SELECT event_id FROM chat_legacy_diagnostics WHERE task_id=? AND ordinal<=?)`,
          params: [taskId, cutoff]
        },
        {
          type: 'run',
          sql: 'DELETE FROM diagnostic_content_holds WHERE event_id IN(SELECT event_id FROM chat_legacy_diagnostics WHERE task_id=? AND ordinal<=?)',
          params: [taskId, cutoff]
        },
        {
          type: 'run',
          sql: 'UPDATE chat_privacy_boundary SET cleanup_generation=cleanup_generation+1 WHERE id=1',
          params: []
        }
      ])
      for (const path of paths)
        if (
          safeBlob(path) &&
          !(await db.get(
            'SELECT 1 FROM diagnostic_content_holds h,json_each(h.blob_paths) p WHERE p.value=? LIMIT 1',
            [path]
          ))
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
