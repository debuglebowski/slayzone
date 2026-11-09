import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createSlayzoneDbAdapter } from '../../../../shared/test-utils/ipc-harness'
import { createDiagnosticsSchema } from './schema'
import { compactDiagnosticContent, eraseDiagnosticContent } from './content-erasure'

test('diagnostic erasure leaves the VACUUM to one later compaction, which skips it when nothing was erased', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diagnostic-compaction-')),
    path = join(dir, 'diagnostics.sqlite'),
    raw = new Database(path),
    secret = 'DIAGNOSTIC-ERASURE-MARKER-5b1e'
  raw.pragma('journal_mode=WAL')
  createDiagnosticsSchema(raw)
  let vacuums = 0
  const exec = raw.exec.bind(raw)
  raw.exec = ((sql: string) => {
    if (/^\s*VACUUM\b/i.test(sql)) vacuums++
    return exec(sql)
  }) as typeof raw.exec
  const db = createSlayzoneDbAdapter(raw)
  const contains = () =>
    [path, path + '-wal'].some(
      (file) => existsSync(file) && readFileSync(file).includes(Buffer.from(secret))
    )
  try {
    raw
      .prepare(
        "INSERT INTO diagnostics_events(id,ts_ms,level,source,event,task_id,message) VALUES('a',1,'error','test','fixture','alice',?)"
      )
      .run(secret.repeat(100))
    // An earlier edit leaves the old text in free space, outside any live row.
    raw.prepare("UPDATE diagnostics_events SET message='redacted' WHERE id='a'").run()
    raw
      .prepare(
        "INSERT INTO diagnostics_events(id,ts_ms,level,source,event,task_id,message) VALUES('b',1,'error','test','fixture','alice',?)"
      )
      .run(secret.repeat(100))
    await eraseDiagnosticContent(db, dir, { jobId: 'job', taskIds: ['alice'], projectIds: [] })
    expect(vacuums).toBe(0)
    expect(raw.prepare('SELECT count(*) AS n FROM diagnostics_events').get()).toEqual({ n: 0 })
    await compactDiagnosticContent(db)
    expect(vacuums).toBe(1)
    expect(contains()).toBe(false)
    await compactDiagnosticContent(db)
    expect(vacuums).toBe(1)
    // An erasure that removes nothing leaves nothing to compact.
    await eraseDiagnosticContent(db, dir, { jobId: 'job-2', taskIds: ['carol'], projectIds: [] })
    await compactDiagnosticContent(db)
    expect(vacuums).toBe(1)
    // A later erasure that removes content makes the file need compaction again.
    raw
      .prepare(
        "INSERT INTO diagnostics_events(id,ts_ms,level,source,event,task_id,message) VALUES('c',1,'error','test','fixture','bob','bob text')"
      )
      .run()
    await eraseDiagnosticContent(db, dir, { jobId: 'job-3', taskIds: ['bob'], projectIds: [] })
    await compactDiagnosticContent(db)
    expect(vacuums).toBe(2)
  } finally {
    raw.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
