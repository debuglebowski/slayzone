import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVersion, setCurrentVersion } from './mutations'
import { getCurrentVersion, listVersions } from './resolve'
import { gcOrphanBlobs, pruneVersions } from './prune'
import { makeTestEnv, type TestEnv } from './test-helpers'

describe('pruneVersions', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeTestEnv()
    env.insertArtifact('a1')
    createVersion(env.db, env.txn, env.blobStore, { artifactId: 'a1', bytes: '1' })
    createVersion(env.db, env.txn, env.blobStore, { artifactId: 'a1', bytes: '2' })
    createVersion(env.db, env.txn, env.blobStore, {
      artifactId: 'a1',
      bytes: '3',
      name: 'milestone',
    })
    createVersion(env.db, env.txn, env.blobStore, { artifactId: 'a1', bytes: '4' })
    createVersion(env.db, env.txn, env.blobStore, { artifactId: 'a1', bytes: '5' })
  })
  afterEach(() => env.cleanup())

  it('keeps last N', () => {
    const r = pruneVersions(env.db, env.txn, env.blobStore, 'a1', { keepLast: 2 })
    expect(r.deletedVersions).toBe(2) // v1, v2 (v3 named, v4-v5 recent)
    expect(r.keptNamed).toBe(1)
    expect(listVersions(env.db, 'a1')).toHaveLength(3)
  })

  it('keepNamed protects milestone', () => {
    const r = pruneVersions(env.db, env.txn, env.blobStore, 'a1', { keepLast: 0 })
    expect(r.keptNamed).toBe(1)
    const remaining = listVersions(env.db, 'a1')
    expect(remaining.some((v) => v.name === 'milestone')).toBe(true)
  })

  it('dryRun does not modify', () => {
    const before = listVersions(env.db, 'a1').length
    const r = pruneVersions(env.db, env.txn, env.blobStore, 'a1', { keepLast: 1, dryRun: true })
    expect(r.deletedVersions).toBeGreaterThan(0)
    expect(listVersions(env.db, 'a1').length).toBe(before)
  })

  it('GCs orphan blobs after deleting version rows', () => {
    const before = env.blobStore.listAllHashes().length
    pruneVersions(env.db, env.txn, env.blobStore, 'a1', { keepLast: 0, keepNamed: false })
    const after = env.blobStore.listAllHashes().length
    expect(after).toBeLessThan(before)
  })

  it('keepCurrent protects current version (default true)', () => {
    setCurrentVersion(env.db, env.txn, 'a1', 2) // switch current to v2
    pruneVersions(env.db, env.txn, env.blobStore, 'a1', { keepLast: 0, keepNamed: false })
    const remaining = listVersions(env.db, 'a1')
    expect(remaining.some((v) => v.version_num === 2)).toBe(true)
    expect(getCurrentVersion(env.db, 'a1')?.version_num).toBe(2)
  })

  it('keepCurrent:false allows deleting current', () => {
    setCurrentVersion(env.db, env.txn, 'a1', 2)
    pruneVersions(env.db, env.txn, env.blobStore, 'a1', {
      keepLast: 0, keepNamed: false, keepCurrent: false,
    })
    const remaining = listVersions(env.db, 'a1')
    expect(remaining.some((v) => v.version_num === 2)).toBe(false)
  })
})

describe('gcOrphanBlobs', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeTestEnv()
    env.insertArtifact('a1')
  })
  afterEach(() => env.cleanup())

  it('removes blobs not referenced by any version', () => {
    createVersion(env.db, env.txn, env.blobStore, { artifactId: 'a1', bytes: 'x' })
    // Manually inject an orphan blob
    const orphan = env.blobStore.write('orphaned')
    env.db.prepare('INSERT OR IGNORE INTO artifact_blobs (hash, size) VALUES (?, ?)').run(orphan.hash, orphan.size)
    const deleted = gcOrphanBlobs(env.db, env.blobStore)
    expect(deleted).toBe(1)
    expect(env.blobStore.has(orphan.hash)).toBe(false)
  })

  it('preserves referenced blobs', () => {
    const v = createVersion(env.db, env.txn, env.blobStore, { artifactId: 'a1', bytes: 'keep' })
    gcOrphanBlobs(env.db, env.blobStore)
    expect(env.blobStore.has(v.content_hash)).toBe(true)
  })
})
