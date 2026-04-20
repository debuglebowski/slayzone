import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createVersion,
  mutateLatestVersion,
  mutateVersion,
  renameVersion,
  readVersionContent,
  saveCurrent,
  setCurrentVersion,
} from './mutations'
import { getCurrentVersion, getLatestVersion, isLocked, listVersions } from './resolve'
import { isVersionError } from './errors'
import { makeTestEnv, type TestEnv } from './test-helpers'

function currentVersionIdInDb(env: TestEnv, assetId: string): string | null {
  const row = env.db
    .prepare('SELECT current_version_id FROM task_assets WHERE id = ?')
    .get(assetId) as { current_version_id: string | null } | undefined
  return row?.current_version_id ?? null
}

describe('createVersion', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeTestEnv()
    env.insertAsset('a1')
  })
  afterEach(() => env.cleanup())

  it('creates v1 from empty', () => {
    const v = createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'hi' })
    expect(v.version_num).toBe(1)
    expect(v.size).toBe(2)
  })

  it('increments version_num on each call', () => {
    createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'a' })
    createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'b' })
    const v = createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'c' })
    expect(v.version_num).toBe(3)
  })

  it('dedupes identical content (no new row)', () => {
    const v1 = createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'same' })
    const v2 = createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'same' })
    expect(v1.id).toBe(v2.id)
    expect(listVersions(env.db, 'a1')).toHaveLength(1)
  })

  it('records author', () => {
    const v = createVersion(env.db, env.txn, env.blobStore, {
      assetId: 'a1',
      bytes: 'x',
      author: { type: 'agent', id: 'claude-code' },
    })
    expect(v.author_type).toBe('agent')
    expect(v.author_id).toBe('claude-code')
  })
})

describe('saveCurrent', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeTestEnv()
    env.insertAsset('a1')
  })
  afterEach(() => env.cleanup())

  it('creates v1 if none exist', () => {
    const v = saveCurrent(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'hi' })
    expect(v.version_num).toBe(1)
    expect(currentVersionIdInDb(env, 'a1')).toBe(v.id)
  })

  it('mutates in place when current is mutable (tip + unnamed)', () => {
    const a = createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'first' })
    const b = saveCurrent(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'second' })
    expect(b.id).toBe(a.id)
    expect(b.content_hash).not.toBe(a.content_hash)
    expect(readVersionContent(env.blobStore, b).toString()).toBe('second')
  })

  it('auto-branches when current is named (locked)', () => {
    const v1 = createVersion(env.db, env.txn, env.blobStore, {
      assetId: 'a1', bytes: 'pinned', name: 'milestone',
    })
    const v2 = saveCurrent(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'changed' })
    expect(v2.id).not.toBe(v1.id)
    expect(v2.parent_id).toBe(v1.id)
    expect(currentVersionIdInDb(env, 'a1')).toBe(v2.id)
  })

  it('back-compat alias: mutateLatestVersion === saveCurrent', () => {
    expect(mutateLatestVersion).toBe(saveCurrent)
  })
})

describe('parent_id wiring', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeTestEnv()
    env.insertAsset('a1')
  })
  afterEach(() => env.cleanup())

  it('linear history: each version points to the previous', () => {
    const v1 = createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: '1' })
    const v2 = createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: '2' })
    const v3 = createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: '3' })
    expect(v1.parent_id).toBeNull()
    expect(v2.parent_id).toBe(v1.id)
    expect(v3.parent_id).toBe(v2.id)
  })

  it('current pointer advances on createVersion', () => {
    const v1 = createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'a' })
    expect(currentVersionIdInDb(env, 'a1')).toBe(v1.id)
    const v2 = createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'b' })
    expect(currentVersionIdInDb(env, 'a1')).toBe(v2.id)
  })
})

describe('setCurrentVersion + branching on edit', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeTestEnv()
    env.insertAsset('a1')
  })
  afterEach(() => env.cleanup())

  it('switches current pointer without mutating content', () => {
    const v1 = createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'one' })
    const v2 = createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'two' })
    expect(currentVersionIdInDb(env, 'a1')).toBe(v2.id)
    setCurrentVersion(env.db, env.txn, 'a1', v1.version_num)
    expect(currentVersionIdInDb(env, 'a1')).toBe(v1.id)
    const reread = getCurrentVersion(env.db, 'a1')
    expect(reread?.id).toBe(v1.id)
  })

  it('saveCurrent after switching to old version branches', () => {
    const v1 = createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'root' })
    const v2 = createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'tip' })
    setCurrentVersion(env.db, env.txn, 'a1', v1.version_num)
    // v1 has a child (v2) so it's locked → edit must branch.
    const branched = saveCurrent(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'alt' })
    expect(branched.id).not.toBe(v1.id)
    expect(branched.id).not.toBe(v2.id)
    expect(branched.parent_id).toBe(v1.id)
    expect(currentVersionIdInDb(env, 'a1')).toBe(branched.id)
    expect(listVersions(env.db, 'a1')).toHaveLength(3)
  })
})

describe('isLocked', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeTestEnv()
    env.insertAsset('a1')
  })
  afterEach(() => env.cleanup())

  it('tip + unnamed = unlocked', () => {
    const v = createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'x' })
    expect(isLocked(env.db, v)).toBe(false)
  })

  it('named = locked', () => {
    const v = createVersion(env.db, env.txn, env.blobStore, {
      assetId: 'a1', bytes: 'x', name: 'pin',
    })
    expect(isLocked(env.db, v)).toBe(true)
  })

  it('has children = locked', () => {
    const v1 = createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: '1' })
    createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: '2' })
    expect(isLocked(env.db, v1)).toBe(true)
  })
})

describe('mutateVersion (CLI escape hatch)', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeTestEnv()
    env.insertAsset('a1')
  })
  afterEach(() => env.cleanup())

  it('mutates a named (locked) version in place', () => {
    const v = createVersion(env.db, env.txn, env.blobStore, {
      assetId: 'a1', bytes: 'pinned', name: 'milestone',
    })
    const mutated = mutateVersion(env.db, env.txn, env.blobStore, {
      assetId: 'a1', ref: v.version_num, bytes: 'patched',
    })
    expect(mutated.id).toBe(v.id)
    expect(readVersionContent(env.blobStore, mutated).toString()).toBe('patched')
  })

  it('mutates a parent (locked by children) in place', () => {
    const v1 = createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: '1' })
    createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: '2' })
    const mutated = mutateVersion(env.db, env.txn, env.blobStore, {
      assetId: 'a1', ref: v1.version_num, bytes: '1-patched',
    })
    expect(mutated.id).toBe(v1.id)
    expect(readVersionContent(env.blobStore, mutated).toString()).toBe('1-patched')
  })
})

describe('createVersion (named / honorUnchanged)', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeTestEnv()
    env.insertAsset('a1')
  })
  afterEach(() => env.cleanup())

  it('with name, honors unchanged content (creates row anyway)', () => {
    createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'same' })
    createVersion(env.db, env.txn, env.blobStore, {
      assetId: 'a1',
      bytes: 'same',
      name: 'snap',
    })
    expect(listVersions(env.db, 'a1')).toHaveLength(2)
  })

  it('honorUnchanged forces a row without a name', () => {
    createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'same' })
    createVersion(env.db, env.txn, env.blobStore, {
      assetId: 'a1',
      bytes: 'same',
      honorUnchanged: true,
    })
    expect(listVersions(env.db, 'a1')).toHaveLength(2)
  })

  it('rejects reserved name', () => {
    try {
      createVersion(env.db, env.txn, env.blobStore, {
        assetId: 'a1',
        bytes: 'x',
        name: 'HEAD',
      })
      throw new Error('expected throw')
    } catch (e) {
      expect(isVersionError(e) && e.code).toBe('NAME_RESERVED')
    }
  })

  it('rejects duplicate name', () => {
    createVersion(env.db, env.txn, env.blobStore, {
      assetId: 'a1',
      bytes: 'a',
      name: 'pin',
    })
    try {
      createVersion(env.db, env.txn, env.blobStore, {
        assetId: 'a1',
        bytes: 'b',
        name: 'pin',
      })
      throw new Error('expected throw')
    } catch (e) {
      expect(isVersionError(e) && e.code).toBe('NAME_TAKEN')
    }
  })
})

describe('renameVersion', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeTestEnv()
    env.insertAsset('a1')
    createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'one' })
    createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'two' })
  })
  afterEach(() => env.cleanup())

  it('sets name', () => {
    const v = renameVersion(env.db, env.txn, 'a1', 1, 'first')
    expect(v.name).toBe('first')
  })

  it('clears name', () => {
    renameVersion(env.db, env.txn, 'a1', 1, 'first')
    const v = renameVersion(env.db, env.txn, 'a1', 1, null)
    expect(v.name).toBeNull()
  })

  it('rejects when name taken on other version', () => {
    renameVersion(env.db, env.txn, 'a1', 1, 'taken')
    try {
      renameVersion(env.db, env.txn, 'a1', 2, 'taken')
      throw new Error('expected throw')
    } catch (e) {
      expect(isVersionError(e) && e.code).toBe('NAME_TAKEN')
    }
  })

  it('allows rename of same version to same name', () => {
    renameVersion(env.db, env.txn, 'a1', 1, 'pin')
    const again = renameVersion(env.db, env.txn, 'a1', 1, 'pin')
    expect(again.name).toBe('pin')
  })
})

describe('latest reflects updates', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeTestEnv()
    env.insertAsset('a1')
  })
  afterEach(() => env.cleanup())

  it('getLatestVersion follows new versions', () => {
    createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'one' })
    expect(getLatestVersion(env.db, 'a1')?.version_num).toBe(1)
    createVersion(env.db, env.txn, env.blobStore, { assetId: 'a1', bytes: 'two' })
    expect(getLatestVersion(env.db, 'a1')?.version_num).toBe(2)
  })
})
