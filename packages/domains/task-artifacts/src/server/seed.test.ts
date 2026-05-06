import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getCurrentVersion, listVersions } from './resolve'
import { seedInitialVersions } from './seed'
import { makeTestEnv, type TestEnv } from './test-helpers'

describe('seedInitialVersions', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeTestEnv()
  })
  afterEach(() => env.cleanup())

  function writeFile(taskId: string, artifactId: string, content: string): string {
    const dir = path.join(env.dataDir, 'artifacts', taskId)
    mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${artifactId}.md`)
    writeFileSync(filePath, content, 'utf-8')
    return filePath
  }

  it('seeds v1 for artifacts without history', () => {
    env.insertArtifact('a1', 'task-1', 'note.md')
    env.insertArtifact('a2', 'task-1', 'spec.md')
    writeFile('task-1', 'a1', 'first')
    writeFile('task-1', 'a2', 'second')

    const r = seedInitialVersions(env.db, env.txn, env.blobStore, {
      resolveFilePath: (row) => path.join(env.dataDir, 'artifacts', row.task_id, `${row.id}.md`),
    })

    expect(r.seeded).toBe(2)
    expect(r.skippedMissing).toBe(0)
    expect(listVersions(env.db, 'a1')).toHaveLength(1)
    expect(listVersions(env.db, 'a2')).toHaveLength(1)
    // Seed must wire current_version_id so getCurrentVersion resolves
    // explicitly (not via the latest fallback).
    const a1Current = getCurrentVersion(env.db, 'a1')
    expect(a1Current?.version_num).toBe(1)
    const row = env.db.prepare('SELECT current_version_id FROM task_artifacts WHERE id = ?').get('a1') as { current_version_id: string | null }
    expect(row.current_version_id).toBe(a1Current?.id)
  })

  it('skips artifacts with missing files', () => {
    env.insertArtifact('a1', 'task-1', 'note.md')
    // No file written

    const r = seedInitialVersions(env.db, env.txn, env.blobStore, {
      resolveFilePath: (row) => path.join(env.dataDir, 'artifacts', row.task_id, `${row.id}.md`),
    })

    expect(r.seeded).toBe(0)
    expect(r.skippedMissing).toBe(1)
  })

  it('is idempotent', () => {
    env.insertArtifact('a1', 'task-1', 'note.md')
    writeFile('task-1', 'a1', 'content')

    const r1 = seedInitialVersions(env.db, env.txn, env.blobStore, {
      resolveFilePath: (row) => path.join(env.dataDir, 'artifacts', row.task_id, `${row.id}.md`),
    })
    const r2 = seedInitialVersions(env.db, env.txn, env.blobStore, {
      resolveFilePath: (row) => path.join(env.dataDir, 'artifacts', row.task_id, `${row.id}.md`),
    })

    expect(r1.seeded).toBe(1)
    expect(r2.seeded).toBe(0)
    expect(listVersions(env.db, 'a1')).toHaveLength(1)
  })

  it('reports progress', () => {
    env.insertArtifact('a1', 'task-1', 'a.md')
    env.insertArtifact('a2', 'task-1', 'b.md')
    writeFile('task-1', 'a1', 'one')
    writeFile('task-1', 'a2', 'two')

    const events: { total: number; done: number }[] = []
    seedInitialVersions(env.db, env.txn, env.blobStore, {
      resolveFilePath: (row) => path.join(env.dataDir, 'artifacts', row.task_id, `${row.id}.md`),
      onProgress: (p) => events.push({ total: p.total, done: p.done }),
    })

    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events[events.length - 1].done).toBe(events[events.length - 1].total)
  })
})
