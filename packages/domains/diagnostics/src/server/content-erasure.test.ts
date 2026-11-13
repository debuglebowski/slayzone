import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createSlayzoneDbAdapter } from '../../../../shared/test-utils/ipc-harness'
import { createDiagnosticsSchema } from './schema'
import { eraseDiagnosticContent } from './content-erasure'
test('diagnostic cleanup removes owned payloads, protects shared files and fences late output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diagnostic-erasure-')),
    raw = new Database(':memory:')
  createDiagnosticsSchema(raw)
  const db = createSlayzoneDbAdapter(raw)
  const own = join(dir, 'owned.png'),
    shared = join(dir, 'shared.png')
  writeFileSync(own, 'alice screenshot')
  writeFileSync(shared, 'shared screenshot')
  const insert = raw.prepare(
    "INSERT INTO diagnostics_events(id,ts_ms,level,source,event,task_id,message,payload_json) VALUES(?,1,'error','test','fixture',?,'private diagnostic',?)"
  )
  insert.run('alice-1', 'alice', JSON.stringify({ screenshotDataUrl: own }))
  insert.run('alice-2', 'alice', JSON.stringify({ screenshotDataUrl: shared }))
  insert.run('bob', 'bob', JSON.stringify({ screenshotDataUrl: shared }))
  try {
    await eraseDiagnosticContent(db, dir, { jobId: 'job', taskIds: ['alice'], projectIds: [] })
    expect(raw.prepare('SELECT id FROM diagnostics_events').all()).toEqual([{ id: 'bob' }])
    expect(existsSync(own)).toBe(false)
    expect(existsSync(shared)).toBe(true)
    expect(() => insert.run('late', 'alice', '{}')).toThrow(/erased/)
  } finally {
    raw.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unassigned held legacy content remains visible as incomplete for account erasure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diagnostic-held-erasure-')),
    raw = new Database(':memory:')
  createDiagnosticsSchema(raw)
  const path = join(dir, 'unknown.png')
  writeFileSync(path, 'unknown owner screenshot')
  raw
    .prepare(
      "INSERT INTO diagnostics_events(id,ts_ms,level,source,event,payload_json) VALUES('held',1,'error','test','legacy',?)"
    )
    .run(JSON.stringify({ screenshotDataUrl: path }))
  raw
    .prepare('INSERT INTO diagnostic_content_holds VALUES(?,?)')
    .run('held', JSON.stringify([path]))
  try {
    await expect(
      eraseDiagnosticContent(createSlayzoneDbAdapter(raw), dir, {
        jobId: 'job',
        taskIds: ['alice'],
        projectIds: [],
        verifyOwnership: true
      })
    ).rejects.toThrow('LEGACY_DIAGNOSTICS_NEED_OWNERSHIP_REVIEW')
    expect(existsSync(path)).toBe(true)
    expect(raw.prepare("SELECT id FROM diagnostics_events WHERE id='held'").get()).toBeDefined()
  } finally {
    raw.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
