import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVersion, setCurrentVersion } from './mutations'
import { diffVersions } from './diff'
import { makeTestEnv, type TestEnv } from './test-helpers'

describe('diffVersions default target', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeTestEnv()
    env.insertArtifact('a1')
    createVersion(env.db, env.txn, env.blobStore, { artifactId: 'a1', bytes: 'alpha\n' })
    createVersion(env.db, env.txn, env.blobStore, { artifactId: 'a1', bytes: 'beta\n' })
    createVersion(env.db, env.txn, env.blobStore, { artifactId: 'a1', bytes: 'gamma\n' })
  })
  afterEach(() => env.cleanup())

  it('diffs against current when b is omitted (not max version_num)', () => {
    // Switch current to v2 — now current is v2, latest is still v3.
    setCurrentVersion(env.db, env.txn, 'a1', 2)
    // diff(v1) w/ no b should be v1 vs current (v2 = 'beta'), not vs latest (v3 = 'gamma').
    const result = diffVersions(env.db, env.blobStore, { artifactId: 'a1', a: 1 })
    if (result.kind !== 'text') throw new Error('expected text diff')
    const allText = result.hunks
      .flatMap((h) => h.lines.map((l) => l.text))
      .join('\n')
    expect(allText).toContain('beta')
    expect(allText).not.toContain('gamma')
  })

  it('diffs explicit b ref', () => {
    const result = diffVersions(env.db, env.blobStore, { artifactId: 'a1', a: 1, b: 3 })
    if (result.kind !== 'text') throw new Error('expected text diff')
    const allText = result.hunks
      .flatMap((h) => h.lines.map((l) => l.text))
      .join('\n')
    expect(allText).toContain('gamma')
  })
})
