import type { SlayzoneDb } from '@slayzone/platform'
import {
  existsSync,
  lstatSync,
  realpathSync,
  rmSync,
  openSync,
  fsyncSync,
  closeSync
} from 'node:fs'
import { resolve, sep } from 'node:path'

function files(value: unknown, result = new Set<string>()): Set<string> {
  if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      if (key === 'screenshotDataUrl' && typeof item === 'string' && !item.startsWith('data:'))
        result.add(item)
      else files(item, result)
    }
  return result
}
function payloadPaths(json: string | null): Set<string> {
  return files(JSON.parse(json ?? 'null'))
}
/** Private payloads follow their proven task/project ownership; security logs are separate. */
export async function eraseDiagnosticContent(
  db: SlayzoneDb,
  blobDir: string | null,
  target: { jobId: string; taskIds: string[]; projectIds: string[]; verifyOwnership?: boolean }
): Promise<void> {
  await db.exec(`PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS diagnostic_erased_tasks(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS diagnostic_erased_projects(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS diagnostic_erasure_files(job_id TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(job_id,path));
    CREATE TRIGGER IF NOT EXISTS diagnostic_erasure_fence BEFORE INSERT ON diagnostics_events
      WHEN EXISTS(SELECT 1 FROM diagnostic_erased_tasks WHERE id=NEW.task_id OR substr(NEW.session_id,1,length(id)+1)=id||':')
        OR EXISTS(SELECT 1 FROM diagnostic_erased_projects WHERE id=NEW.project_id)
      BEGIN SELECT RAISE(ABORT,'Diagnostic content was permanently erased'); END;`)
  const params = [
    JSON.stringify(target.taskIds),
    JSON.stringify(target.projectIds),
    JSON.stringify(target.taskIds)
  ]
  const legacy = !!(await db.get(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_legacy_diagnostics'"
  ))
  const locks = !!(await db.get(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_content_locks'"
  ))
  let owned = `task_id IN(SELECT value FROM json_each(?)) OR project_id IN(SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM json_each(?) WHERE substr(session_id,1,length(value)+1)=value||':')`
  if (legacy) {
    owned +=
      ' OR id IN(SELECT event_id FROM chat_legacy_diagnostics WHERE task_id IN(SELECT value FROM json_each(?)))'
    params.push(JSON.stringify(target.taskIds))
  }
  const selected = await db.all<{ id: string; payload_json: string | null }>(
    `SELECT id,payload_json FROM diagnostics_events WHERE ${owned}`,
    params
  )
  const paths = new Set(selected.flatMap((row) => [...payloadPaths(row.payload_json)]))
  if (locks)
    for (const row of await db.all<{ blobs: string }>(
      'SELECT blobs FROM chat_content_locks WHERE task_id IN(SELECT value FROM json_each(?))',
      [JSON.stringify(target.taskIds)]
    ))
      for (const path of JSON.parse(row.blobs) as string[]) paths.add(path)
  const ids = JSON.stringify(selected.map((row) => row.id))
  for (const row of await db.all<{ blob_paths: string }>(
    'SELECT blob_paths FROM diagnostic_content_holds WHERE event_id IN(SELECT value FROM json_each(?))',
    [ids]
  ))
    for (const path of JSON.parse(row.blob_paths) as string[]) paths.add(path)
  await db.batchTxn([
    ...target.taskIds.map((id) => ({
      type: 'run' as const,
      sql: 'INSERT OR IGNORE INTO diagnostic_erased_tasks VALUES(?)',
      params: [id]
    })),
    ...target.projectIds.map((id) => ({
      type: 'run' as const,
      sql: 'INSERT OR IGNORE INTO diagnostic_erased_projects VALUES(?)',
      params: [id]
    })),
    ...[...paths].map((path) => ({
      type: 'run' as const,
      sql: 'INSERT OR IGNORE INTO diagnostic_erasure_files VALUES(?,?)',
      params: [target.jobId, path]
    })),
    {
      type: 'run',
      sql: 'DELETE FROM diagnostic_content_holds WHERE event_id IN(SELECT value FROM json_each(?))',
      params: [ids]
    },
    { type: 'run', sql: `DELETE FROM diagnostics_events WHERE ${owned}`, params }
  ])
  const retained = new Set<string>()
  for (const row of await db.all<{ payload_json: string | null }>(
    'SELECT payload_json FROM diagnostics_events'
  ))
    for (const path of payloadPaths(row.payload_json)) retained.add(path)
  for (const row of await db.all<{ blob_paths: string }>(
    'SELECT blob_paths FROM diagnostic_content_holds'
  ))
    for (const path of JSON.parse(row.blob_paths) as string[]) retained.add(path)
  for (const { path } of await db.all<{ path: string }>(
    'SELECT path FROM diagnostic_erasure_files WHERE job_id=?',
    [target.jobId]
  )) {
    if (retained.has(path) || !existsSync(path)) continue
    if (
      !blobDir ||
      !resolve(path).startsWith(resolve(blobDir) + sep) ||
      lstatSync(path).isSymbolicLink() ||
      !realpathSync(path).startsWith(realpathSync(blobDir) + sep)
    )
      throw new Error('Diagnostic file ownership could not be verified')
    rmSync(path)
    if (existsSync(path)) throw new Error('Diagnostic file remains')
  }
  if (blobDir && existsSync(blobDir) && process.platform !== 'win32') {
    const fd = openSync(blobDir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
  await db.run('DELETE FROM diagnostic_erasure_files WHERE job_id=?', [target.jobId])
  if (locks)
    await db.run(
      'DELETE FROM chat_content_locks WHERE task_id IN(SELECT value FROM json_each(?))',
      [JSON.stringify(target.taskIds)]
    )
  await db.exec('VACUUM')
  const checkpoint = await db.all<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)')
  if (checkpoint.some((row) => row.busy)) throw new Error('Diagnostic checkpoint is busy')
  if (target.verifyOwnership) {
    const unknown =
      await db.get(`SELECT 1 FROM diagnostic_content_holds h LEFT JOIN diagnostics_events e ON e.id=h.event_id
      WHERE e.task_id IS NULL AND e.project_id IS NULL ${legacy ? 'AND NOT EXISTS(SELECT 1 FROM chat_legacy_diagnostics l WHERE l.event_id=h.event_id AND l.task_id IS NOT NULL)' : ''} LIMIT 1`)
    if (unknown) throw new Error('LEGACY_DIAGNOSTICS_NEED_OWNERSHIP_REVIEW')
  }
}
