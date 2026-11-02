import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createStandaloneArtifacts } from './standalone'

test('artifact search orders mixed SQLite/ISO timestamps chronologically and reports the remaining candidate limit accurately', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-search-order-')),
    raw = new Database(':memory:')
  const { db, store } = createStandaloneArtifacts(raw, dir)
  try {
    const older = (await store.createArtifact(db, { taskId: 'task', title: 'needle older.txt' }))!
    const newer = (await store.createArtifact(db, { taskId: 'task', title: 'needle newer.txt' }))!
    raw
      .prepare('UPDATE task_artifacts SET updated_at=? WHERE id=?')
      .run('2026-01-01T08:00:00.000Z', older.id)
    raw
      .prepare('UPDATE task_artifacts SET updated_at=? WHERE id=?')
      .run('2026-01-01 09:00:00', newer.id)
    expect(
      (
        await store.searchArtifacts(db, {
          taskId: 'task',
          query: 'needle',
          titlesOnly: true,
          limit: 1
        })
      ).results[0].artifactId
    ).toBe(newer.id)
    const last = await store.searchArtifacts(db, {
      taskId: 'task',
      query: 'older',
      titlesOnly: true,
      limit: 1
    })
    expect(last.results).toHaveLength(1)
    expect(last.truncated).toBe(false)
  } finally {
    raw.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
